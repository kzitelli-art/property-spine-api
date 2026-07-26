#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/enroll_demo_participants.js
//
//  Moves Demo Building records from 'production' to 'internal_qa' so the
//  demo can run under internal_qa_autonomous WITHOUT anything pretending
//  to be a real prospect.
//
//  WHY: Fable ruling 2026-07-25 — Demo Building must never be a
//  production property. Owner direction the same day — "a real person
//  participating in a controlled demo can correctly have an internal_qa
//  Person x Property record. Classification describes the operating
//  context of the record, not whether the human physically exists."
//
//  SAFETY:
//    · DRY RUN BY DEFAULT. Writes only with --apply.
//    · Every write goes through boundary.reclassify() — the governed path
//      that SUPERSEDES the old row and appends a new one. Never a raw
//      UPDATE, never an edit in place. Full history is preserved and the
//      change is reversible by reclassifying back.
//    · actor_user_id is a REAL human, passed in. Never a seeded user.
//    · contact_preferences is NEVER read for modification and NEVER
//      written. Consent is a separate truth (Fable section 3).
//    · The opted-out ...7147 record is excluded by explicit rule and the
//      exclusion is asserted, not assumed.
//    · Scoped to Demo Building only. No other property is touched.
//
//  REVERSIBLE: to undo, reclassify the same person_ids back to
//  'production'. The superseded rows remain as history either way.
//
//  USAGE:
//    node tools/enroll_demo_participants.js                 (dry run)
//    node tools/enroll_demo_participants.js --apply --actor <uuid>
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const boundaryFactory = require("../src/comms/communications_boundary");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const NEVER_TOUCH_TAIL = "7147";
const APPLY = process.argv.includes("--apply");
const ACTOR = (() => {
  const i = process.argv.indexOf("--actor");
  return i > -1 ? process.argv[i + 1] : null;
})();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const boundary = boundaryFactory({ pool, sms: null });

const REASON = "Demo Building is not a production property (Fable ruling 2026-07-25). "
             + "Controlled demo context: classification describes the operating context of "
             + "the record, not whether the human exists. Owner-directed.";

(async () => {
  if (APPLY && !ACTOR) {
    console.error("\n  REFUSED: --apply requires --actor <real user uuid>. Never a seeded user.\n");
    process.exit(1);
  }
  if (APPLY) {
    const u = (await pool.query("select id, name, email from users where id=$1", [ACTOR])).rows[0];
    if (!u) { console.error(`\n  REFUSED: no user ${ACTOR}\n`); process.exit(1); }
    console.log(`\n  ACTOR: ${u.name} <${u.email || "no email"}>  ${u.id}`);
  }

  console.log(`\n  MODE: ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`  PROPERTY: ${DEMO}\n`);

  const rows = (await pool.query(
    `select p.id as person_id, p.name, p.phone,
            coalesce(c.classification_reason,'(none)') as prior_reason
       from person_property_classifications c
       join persons p on p.id = c.person_id
      where c.property_id = $1 and c.superseded_at is null
        and c.record_class = 'production'
      order by p.name`, [DEMO])).rows;

  const excluded = rows.filter(r => (r.phone || "").endsWith(NEVER_TOUCH_TAIL));
  const targets  = rows.filter(r => !(r.phone || "").endsWith(NEVER_TOUCH_TAIL));

  console.log(`  production records found : ${rows.length}`);
  console.log(`  EXCLUDED (opted-out)     : ${excluded.length}  ${excluded.map(e => e.name + " ..." + e.phone.slice(-4)).join(", ")}`);
  console.log(`  to move -> internal_qa   : ${targets.length}\n`);

  // hard assertion: the excluded record must not be in the target set
  if (targets.some(t => (t.phone || "").endsWith(NEVER_TOUCH_TAIL))) {
    console.error("  REFUSED: the excluded record leaked into the target set.");
    process.exit(1);
  }
  if (excluded.length === 0) {
    console.error(`  REFUSED: the ...${NEVER_TOUCH_TAIL} record was not found among production records.`);
    console.error("  Expected it to be present and excluded. Investigate before applying.\n");
    if (APPLY) process.exit(1);
  }

  let done = 0, failed = 0;
  for (const t of targets) {
    const label = `${t.name} ...${(t.phone || "").slice(-4)}  ${t.person_id}`;
    if (!APPLY) { console.log(`   would move  ${label}`); continue; }
    try {
      await boundary.reclassify({
        person_id: t.person_id,
        property_id: DEMO,
        record_class: "internal_qa",
        actor_user_id: ACTOR,
        reason: REASON,
      });
      console.log(`   moved       ${label}`);
      done++;
    } catch (e) {
      console.error(`   FAILED      ${label} — ${e.message}`);
      failed++;
    }
  }

  // ── verify ────────────────────────────────────────────────────────
  const after = (await pool.query(
    `select record_class, count(*)::int c
       from person_property_classifications
      where property_id=$1 and superseded_at is null
      group by 1 order by 1`, [DEMO])).rows;
  console.log("\n  classification at Demo Building now:");
  console.table(after);

  const stillProd = (await pool.query(
    `select p.name, right(coalesce(p.phone,''),4) as last4
       from person_property_classifications c join persons p on p.id=c.person_id
      where c.property_id=$1 and c.superseded_at is null and c.record_class='production'`, [DEMO])).rows;
  console.log(`  still 'production': ${stillProd.length}`);
  if (stillProd.length) console.table(stillProd);

  const consent = (await pool.query(
    `select consent_state, count(*)::int c from contact_preferences group by 1 order by 1`)).rows;
  console.log("  consent states (must be unchanged: 113 opted_in / 3 opted_out):");
  console.table(consent);

  console.log(`\n  ${APPLY ? `applied: ${done}, failed: ${failed}` : "dry run — nothing written"}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch(e => { console.error("ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
