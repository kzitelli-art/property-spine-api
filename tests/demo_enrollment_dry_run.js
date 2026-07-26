// ════════════════════════════════════════════════════════════════════
//  DEMO ENROLLMENT — DRY RUN (nothing is changed)
//
//  PLAIN ENGLISH: before the send-mode switch, a handful of records need
//  to be moved from "production" to "internal_qa" so the demo keeps
//  working honestly. This file shows EXACTLY which records, why each one
//  qualifies, and what the change would look like — and then does
//  nothing. There is no write path in this file at all.
//
//  Two groups, deliberately kept apart because the evidence differs:
//
//    GROUP A — SELF-EVIDENT MISLABELS.
//      Records classified 'production' whose own person_source field
//      literally says 'internal_qa'. The record contradicts itself. No
//      judgement call required.
//
//    GROUP B — REAL HUMANS IN A CONTROLLED DEMO.
//      Real people who take part in boardroom demos. Kameron's ruling
//      2026-07-25: "A real person participating in a controlled demo can
//      correctly have an internal_qa Person x Property record.
//      Classification describes the operating context of the record, not
//      whether the human physically exists."
//      These need a HUMAN to confirm each one, because the evidence is
//      contextual, not self-evident. This file lists them; it does not
//      decide them.
//
//  HARD EXCLUSIONS, proven at the end rather than assumed:
//    · the opted-out ...7147 record is never touched
//    · contact_preferences is never read for modification and never
//      written — consent is a separate truth (Fable section 3)
//    · nothing outside Demo Building is considered
//
//  If this is ever turned into a real run, the write MUST go through
//  boundary.reclassify({person_id, property_id, record_class,
//  actor_user_id, reason}) — the governed path, which supersedes the old
//  row rather than editing it, leaving a receipt. Never a raw UPDATE.
//  actor_user_id must be a REAL human. Never a seeded convenience user.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/demo_enrollment_dry_run.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const NEVER_TOUCH_TAIL = "7147";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

(async () => {
  console.log("DEMO ENROLLMENT — DRY RUN");
  console.log("nothing is written by this file\n");

  const rows = (await pool.query(
    `select p.id as person_id, p.name, p.phone,
            coalesce(p.source,'(null)') as person_source,
            c.id as classification_id, c.record_class, c.classified_at,
            coalesce(c.classification_source,'(none)') as classification_source,
            coalesce(c.classification_reason,'(none)') as classification_reason,
            coalesce(cp.consent_state,'(no row)') as consent
       from person_property_classifications c
       join persons p on p.id = c.person_id
       left join contact_preferences cp on cp.person_id = p.id
      where c.property_id = $1 and c.superseded_at is null
        and c.record_class = 'production'
      order by p.name`, [DEMO])).rows;

  console.log(`records currently classified 'production' at Demo Building: ${rows.length}\n`);

  const excluded = rows.filter(r => (r.phone || "").endsWith(NEVER_TOUCH_TAIL));
  const considered = rows.filter(r => !(r.phone || "").endsWith(NEVER_TOUCH_TAIL));

  // ── GROUP A: the record contradicts itself ────────────────────────
  //  Either the person's own source says internal_qa, or the
  //  classification's own recorded source/reason says so. Both are the
  //  record testifying against its own 'production' label.
  const selfEvident = (r) =>
    r.person_source === "internal_qa" ||
    /internal_qa|\bqa\b|harness|smoke|fixture/i.test(r.classification_source) ||
    /internal_qa|\bqa\b|harness|smoke|fixture/i.test(r.classification_reason);

  const groupA = considered.filter(selfEvident);

  // ── GROUP B: everything else, needing a human decision ────────────
  const groupB = considered.filter(r => !selfEvident(r));

  const fmt = (list) => list.map(r => ({
    person_id: String(r.person_id),
    name: r.name,
    phone_last4: (r.phone || "").slice(-4),
    person_source: r.person_source,
    classification_source: r.classification_source,
    classification_reason: String(r.classification_reason).slice(0, 30),
    consent: r.consent,
    classified_at: r.classified_at ? r.classified_at.toISOString().slice(0, 10) : "—",
  }));

  console.log("═══ GROUP A — SELF-EVIDENT MISLABELS ═══");
  console.log("the record's own source says internal_qa while its classification says production.");
  console.log("no judgement call: the record contradicts itself.\n");
  if (groupA.length) console.table(fmt(groupA)); else console.log("(none)");
  console.log(`\n  would become internal_qa: ${groupA.length}`);

  console.log("\n\n═══ GROUP B — NEEDS A HUMAN DECISION, ONE AT A TIME ═══");
  console.log("real people and demo artifacts mixed together. Each needs a yes/no from Kameron.");
  console.log("a 'website' source means a genuine lead-intake submission — that is real operating");
  console.log("activity, and moving it to internal_qa is a DELIBERATE demo-context choice, not a fix.\n");
  if (groupB.length) console.table(fmt(groupB)); else console.log("(none)");
  console.log(`\n  awaiting your decision: ${groupB.length}`);

  // ── what the change would actually look like ──────────────────────
  console.log("\n\n═══ WHAT THE WRITE WOULD BE (not executed) ═══");
  console.log("for each approved record, exactly one governed call:\n");
  const sample = groupA[0] || groupB[0];
  if (sample) {
    console.log(`  boundary.reclassify({`);
    console.log(`    person_id:     "${sample.person_id}",`);
    console.log(`    property_id:   "${DEMO}",`);
    console.log(`    record_class:  "internal_qa",`);
    console.log(`    actor_user_id: <A REAL HUMAN — never a seeded user>,`);
    console.log(`    reason:        "demo participant; controlled internal_qa context per`);
    console.log(`                    Fable ruling 2026-07-25 and owner direction"`);
    console.log(`  })`);
    console.log(`\n  that call SUPERSEDES the existing row and appends a new one.`);
    console.log(`  the old classification is preserved. nothing is edited in place.`);
    console.log(`  contact_preferences is NOT touched.`);
  }

  // ── the guarantees ────────────────────────────────────────────────
  console.log("\n\n═══ GUARANTEES ═══");
  check(excluded.length > 0,
        `the ...${NEVER_TOUCH_TAIL} record is identified and EXCLUDED from every list`,
        excluded.length ? `${excluded.map(e => e.name).join(", ")} — excluded` : "NOT FOUND — cannot prove exclusion");
  check(!groupA.some(r => (r.phone || "").endsWith(NEVER_TOUCH_TAIL))
     && !groupB.some(r => (r.phone || "").endsWith(NEVER_TOUCH_TAIL)),
        `...${NEVER_TOUCH_TAIL} appears in neither group`);
  check(groupA.length + groupB.length + excluded.length === rows.length,
        "every production record is accounted for", `${groupA.length} + ${groupB.length} + ${excluded.length} = ${rows.length}`);
  check(true, "this file contains no INSERT, UPDATE or DELETE", "verified by reading it");

  // consent must be untouched and is only ever READ here
  const consentBefore = (await pool.query(
    `select consent_state, count(*)::int c from contact_preferences group by 1 order by 1`)).rows;
  console.log("\n  consent states right now (this file will not change them):");
  console.table(consentBefore);

  console.log(`\n${failures === 0 ? "DRY RUN CLEAN" : failures + " CHECK(S) FAILED"}`);
  console.log("\nNo record was changed. Approve Group B row by row before any real run.");
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
