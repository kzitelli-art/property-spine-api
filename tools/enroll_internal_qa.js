#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/enroll_internal_qa.js — governed QA enrollment (Render Shell)
//
//  Enrolls an EXISTING person (intake them through the canonical path
//  first) as internal_qa for ONE property. In one transaction it writes
//  the two separate canonical facts:
//    1. person_property_classifications: current internal_qa row
//       (append-only supersession of any prior current row)
//    2. contact_preferences: consent_state='opted_in' for text
//
//  Usage (Render Shell):
//    node tools/enroll_internal_qa.js \
//      --person  <person uuid> \
//      --property <property uuid> \
//      --actor   <staff user uuid>   (attribution; optional) \
//      --reason  "boardroom QA tester"  (optional) \
//      --yes
//
//  Class 3: controlled operations infrastructure outside the operator
//  workflow. The classification it writes is Class 1 durable truth.
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const person_id = arg("person");
const property_id = arg("property");
const actor_user_id = arg("actor");
const reason = arg("reason") || "internal QA enrollment";
const confirmed = process.argv.includes("--yes");

if (!person_id || !property_id || !confirmed) {
  console.error("Usage: node tools/enroll_internal_qa.js --person <uuid> --property <uuid> [--actor <uuid>] [--reason \"...\"] --yes");
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const boundary = require("../src/comms/communications_boundary.js")({ pool, sms: null });
  try {
    const out = await boundary.enrollInternalQa({ person_id, property_id, actor_user_id, reason });
    console.log("── RECEIPT ──");
    console.log(out.receipt);
    console.log("classification id:", out.classification.id);
    console.log("record_class:", out.classification.record_class, "· classified_at:", out.classification.classified_at);
    // Corrected 2026-07-26. This used to say autonomous sends required
    // SMS_SEND_MODE=internal_qa_autonomous. That mode is retired and class no
    // longer gates sending at all, so the old line would send someone to set
    // an env value that now silences the deploy entirely.
    console.log("Next: autonomous sends need SMS_SEND_MODE=customer_care, consent 'opted_in',");
    console.log("      and a relationship at this property. The classification above gates NOTHING");
    console.log("      about sending — it marks the record as a test context for replay and metrics.");
  } catch (e) {
    console.error("ENROLLMENT FAILED:", e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
