#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  no076_failclosed_check.js — MIGRATION MATRIX, STATE 3
//
//  Proves: NEW code running WITHOUT migration 076 (the classification
//  table missing — e.g. a rolling Render instance that starts before the
//  migration lands) REFUSES communications safely. It does not crash,
//  and it does not bypass the classification gate.
//
//  Point it at a database that has the base schema but NOT
//  person_property_classifications:
//    DATABASE_URL=postgres://... node no076_failclosed_check.js
//
//  (On Neon this can be run BEFORE applying 076 for a live receipt of
//  the same state; it creates and removes only __CB_NO076__* rows.)
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://claude:claude@localhost/spinetest_no076",
  ssl: process.env.PGSSL ? { rejectUnauthorized: false } : false,
});
const wireLog = [];
const fakeSms = {
  enabled: () => true,
  async sendSms({ to, from, body }) { wireLog.push({ to, from, body }); return { sent: true, sid: "SM_NO076", status: "queued" }; },
  validateWebhook: () => true,
};
const boundary = require("../comms/communications_boundary")({ pool, sms: fakeSms });

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`)); };

(async () => {
  console.log("═══ STATE 3: NEW CODE, NO MIGRATION 076 ═══\n");
  const missing = (await pool.query(
    `select to_regclass('person_property_classifications') is null as missing`)).rows[0].missing;
  if (!missing) { console.error("This database HAS the 076 table — point at a pre-076 database."); process.exit(2); }
  console.log("  (confirmed: person_property_classifications does not exist here)\n");

  const prop = (await pool.query(`insert into properties (name, sms_number) values ('__CB_NO076__P', '+15550076001') returning *`)).rows[0];
  const per = (await pool.query(`insert into persons (name, phone) values ('__CB_NO076__Res', '+15550076002') returning *`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [per.id, prop.id]);

  // 1. Phase A reality: disabled mode never touches the table — safe.
  delete process.env.SMS_SEND_MODE;
  let r1, crashed1 = false;
  try { r1 = await boundary.sendPropertySms({ property_id: prop.id, recipient: per.phone, body: "x", purpose: "agent", person_id: per.id }); }
  catch (e) { crashed1 = true; }
  check("disabled mode (Phase A default): refuses cleanly, no table access, no crash",
    !crashed1 && r1 && r1.sent === false && r1.reason === "send_mode_disabled");

  // 2. Classified mode with the table missing: REFUSE, don't crash, don't bypass.
  process.env.SMS_SEND_MODE = "customer_care";
  process.env.SMS_QA_PROPERTY_ID = "00000000-0000-0000-0000-000000000000";
  let r2, crashed2 = false;
  try { r2 = await boundary.sendPropertySms({ property_id: prop.id, recipient: per.phone, body: "x", purpose: "agent", person_id: per.id }); }
  catch (e) { crashed2 = true; console.error("  crash:", e.message); }
  // UPDATED 2026-07-26. These two used to assert the refusal reason was
  // `classification_unavailable`, because sending was gated on a record
  // class. It no longer is — class left eligibility entirely — so that
  // reason can never come back, and an assertion demanding it would fail
  // for the wrong cause and get "fixed" by loosening it.
  //
  // The property under test was never the reason string. It is that a
  // missing or unreadable source REFUSES rather than proceeds. The gate
  // that now decides is consent, and absence of consent is refusal, so the
  // fail-closed guarantee is intact — it just answers in a different word.
  check("classification table missing: still refuses, still no crash (fail closed)",
    !crashed2 && r2 && r2.sent === false, r2 && r2.reason);

  process.env.SMS_SEND_MODE = "customer_care";
  let r3, crashed3 = false;
  try { r3 = await boundary.sendPropertySms({ property_id: prop.id, recipient: per.phone, body: "x", purpose: "agent", person_id: per.id }); }
  catch (e) { crashed3 = true; }
  check("customer_care with no consent on record: refuses (absence is refusal, not 'undecided')",
    !crashed3 && r3 && r3.sent === false, r3 && r3.reason);

  check("ZERO wire attempts in any state-3 scenario", wireLog.length === 0, `wires=${wireLog.length}`);

  await pool.query(`delete from comm_events where property_id=$1`, [prop.id]);
  await pool.query(`delete from leasing_leads where property_id=$1`, [prop.id]);
  await pool.query(`delete from persons where name like '__CB_NO076__%'`);
  await pool.query(`delete from properties where name like '__CB_NO076__%'`);
  console.log(`\n═══ RESULT: ${pass} passed · ${fail} failed ═══`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => { console.error("CRASH:", e); try { await pool.end(); } catch (_) {} process.exit(2); });
