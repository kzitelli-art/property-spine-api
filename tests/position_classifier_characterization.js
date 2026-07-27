// ════════════════════════════════════════════════════════════════════
//  position_classifier_characterization.js
//
//  Proves the classifier extraction changed NO behaviour, by running the
//  PRE-EXTRACTION implementation (recovered from git) and the current one
//  against the SAME live data in the same process, and asserting deep
//  equality of every position.
//
//  This is deliberately not a golden-file test: the database is live, so a
//  stored snapshot would drift and the test would rot into noise. Running
//  both implementations against one dataset cannot be fooled by drift.
//
//  Also asserts the classifier is genuinely PURE — it must produce its
//  answer with no pool, no client, no network.
//
//  Run:  DATABASE_URL=... node tests/position_classifier_characterization.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");

const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

// The commit that introduced the classifier; its parent is the pre-extraction
// implementation. `~1`, never `^` — execSync goes through cmd.exe on Windows
// where `^` is the escape character and is silently eaten.
function preExtractionSource() {
  const adding = execSync("git log --diff-filter=A --format=%H -- src/tenancy/position_classifier.js",
    { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
  const baseline = adding ? `${adding}~1` : "HEAD";
  return { baseline, src: execSync(`git show ${baseline}:src/tenancy/space_position.js`, { cwd: REPO, encoding: "utf8", maxBuffer: 40e6 }) };
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }

  console.log("\n══ BLOCK A — the classifier is pure ══");
  const { classifyPosition } = require(path.join(REPO, "src/tenancy/position_classifier"));
  const srcText = fs.readFileSync(path.join(REPO, "src/tenancy/position_classifier.js"), "utf8");
  const code = srcText.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  ok(!/require\(["']pg["']\)/.test(code), "classifier does not require pg");
  ok(!/\bpool\b|\bclient\.query\b|await /.test(code), "classifier contains no pool, no client.query and no await");
  ok(!/Date\.now\(|new Date\(\)/.test(code), "classifier reads no clock — asOf is supplied");

  // It must answer with no database in the process at all.
  const synthetic = classifyPosition({
    space_id: "s1", unit_id: "u1", unit_number: "101", space_label: null,
    leases: [
      { id: "L1", lease_status: "active", start_date: "2026-01-01", end_date: "2026-08-31", rent: "1500", tenant_ids: ["p1"], source_type: "historical_snapshot", confidence: "confirmed" },
      { id: "L2", lease_status: "pending", start_date: "2026-09-01", end_date: "2027-08-31", rent: "1600", tenant_ids: ["p2"] },
    ],
    possession_events: [], notice_date: null, turn_status: null, compat_occupancy: "occupied",
  }, { asOf: "2026-07-27", personNames: new Map([["p1", "Ada"]]) });
  ok(synthetic.current_lease_position && synthetic.current_lease_position.lease_id === "L1", "classifies the spanning lease with no DB");
  ok(synthetic.current_lease_position.proof_basis === "confirmed_opening_import", "proof basis from supplied data");
  ok(synthetic.successor.state === "pending" && synthetic.successor.lease_id === "L2", "successor is pending, not locked, on lease_status alone");
  ok(synthetic.conflict_state === "clear", "sequential handoff is not a conflict");

  const conflicted = classifyPosition({
    space_id: "s2", unit_id: "u2", unit_number: "102", space_label: null,
    leases: [
      { id: "A", lease_status: "active", start_date: "2026-01-01", end_date: "2026-12-31", rent: "1", tenant_ids: [] },
      { id: "B", lease_status: "pending", start_date: "2026-06-01", end_date: "2027-05-31", rent: "1", tenant_ids: [] },
    ],
    possession_events: [], notice_date: null, turn_status: null, compat_occupancy: "occupied",
  }, { asOf: "2026-07-27", personNames: new Map() });
  ok(conflicted.conflict_state === "conflicted", "overlapping leases are a conflict");
  ok(conflicted.successor.state === "none", "an overlapping lease is NOT treated as a successor");

  const lockedCase = classifyPosition({
    space_id: "s3", unit_id: "u3", unit_number: "103", space_label: null,
    leases: [
      { id: "C", lease_status: "active", start_date: "2026-01-01", end_date: "2026-08-31", rent: "1", tenant_ids: [] },
      { id: "D", lease_status: "pending", start_date: "2026-09-01", end_date: "2027-08-31", rent: "1", tenant_ids: [], executed_verified: true, move_in_funds_cleared: true },
    ],
    possession_events: [], notice_date: null, turn_status: null, compat_occupancy: "occupied",
  }, { asOf: "2026-07-27", personNames: new Map() });
  ok(lockedCase.successor.state === "locked", "executed AND funded successor is locked");
  ok(lockedCase.successor.proof_basis === "native_verified", "locked successor carries native_verified");

  console.log("\n══ BLOCK B — no behaviour change vs the pre-extraction implementation ══");
  const { baseline, src } = preExtractionSource();
  console.log(`   (baseline = ${baseline})`);
  ok(/const positions = rows\.map\(\(row\) => \{/.test(src), "recovered source is the pre-extraction implementation");
  ok(!/position_classifier/.test(src), "recovered source predates the classifier");

  const tmp = path.join(os.tmpdir(), `space_position_baseline_${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  const before = require(tmp);
  const after = require(path.join(REPO, "src/tenancy/space_position"));

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const props = [DEMO];
  for (const pid of props) {
    for (const asOf of [null, "2026-10-25", "2026-01-15"]) {
      const a = await before.spacePosition(pool, { property_id: pid, as_of: asOf });
      const b = await after.spacePosition(pool, { property_id: pid, as_of: asOf });
      const label = `as_of=${asOf || "today"}`;
      ok(a.positions.length === b.positions.length, `${label}: same position count (${a.positions.length})`);
      const ja = JSON.stringify(a.positions), jb = JSON.stringify(b.positions);
      if (ja !== jb) {
        // Show the first differing position so a real regression is diagnosable.
        for (let i = 0; i < a.positions.length; i++) {
          if (JSON.stringify(a.positions[i]) !== JSON.stringify(b.positions[i])) {
            console.log("     first difference at index " + i + " (space " + a.positions[i].space_id + ")");
            console.log("       before: " + JSON.stringify(a.positions[i]).slice(0, 300));
            console.log("       after:  " + JSON.stringify(b.positions[i]).slice(0, 300));
            break;
          }
        }
      }
      ok(ja === jb, `${label}: every position is byte-identical after extraction`);
      ok(JSON.stringify(a.summary) === JSON.stringify(b.summary), `${label}: summary identical`);
      ok(a.as_of === b.as_of && a.count === b.count, `${label}: envelope identical`);
    }
  }

  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL:", e.message); process.exit(1); });
