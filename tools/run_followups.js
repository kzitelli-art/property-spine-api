// run_followups.js — run one pass of the follow-up ladder.
//
//   node tools/run_followups.js              # DRY RUN, sends nothing
//   node tools/run_followups.js --send       # actually sends
//
// Dry run is the default and --send must be typed. Every send still passes
// through commBoundary: consent, scope, send mode, and quiet hours.
//
// Class 3. Removal condition: delete when a scheduled runner with an
// operator-facing preview replaces the manual trigger.

const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { Pool } = require("pg");

const PROPERTY = process.env.FOLLOWUP_PROPERTY_ID || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const SEND = process.argv.includes("--send");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sms = null; // boundary derives its own transport; nothing raw here
  const commBoundary = require(path.join(__dirname, "..", "src", "comms", "communications_boundary.js"))({ pool, sms });
  const runner = require(path.join(__dirname, "..", "src", "leasing", "followup_runner.js"))({ pool, commBoundary });

  try {
    const out = await runner.runFollowups({ propertyId: PROPERTY, dryRun: !SEND });

    console.log(`\n=== FOLLOW-UP PASS ${out.dryRun ? "(DRY RUN, nothing sent)" : "(LIVE)"} ===`);
    console.log(`examined: ${out.examined}`);

    console.log(`\n${out.dryRun ? "WOULD SEND" : "SENT"}: ${out.sent.length}`);
    for (const s of out.sent) {
      console.log(`  rung ${s.rung} (${s.job}) → ${s.name}${s.sid ? `  sid=${s.sid}` : ""}`);
      if (s.body) console.log(`    "${s.body}"`);
    }

    if (out.failed.length) {
      console.log(`\nFAILED: ${out.failed.length}`);
      for (const f of out.failed) console.log(`  ${f.name}: ${f.reason}`);
    }

    // Grouped, because the interesting part is usually WHY nothing went out.
    const byReason = {};
    for (const s of out.skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    console.log(`\nHELD: ${out.skipped.length}`);
    for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n.toString().padStart(3)}  ${reason}`);
    }
    if (out.dryRun) console.log(`\nNothing was sent. Re-run with --send to send.\n`);
  } catch (e) {
    console.error("RUN ERROR:", e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
