#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   tracker_intake.db.js — the tracker is EVIDENCE, not truth.

   The claims under test are boundary claims, not arithmetic:

     · staging writes NO lease and mints NO person
     · a tracker commitment with no canonical lease stays a CLAIM
     · an identity conflict is refused, never resolved by picking a column
     · an unattachable claim is SURFACED, never dropped from the totals
     · the tracker's rent is labelled CLAIMED, never contracted
     · nothing is promoted

   Run:
     HARNESS_DATABASE_URL=… node tests/tracker_intake.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { stageTrackerClaims, parseTrackerSheet, TARGET_TYPE } = require("../src/leasing/tracker_intake");
const { forwardLeasingPosition } = require("../src/leasing/forward_leasing_read");

const HARNESS = __filename;
const EXPECTED = 16;
let passed = 0, failed = 0, ran = 0;
const ok = (label, cond, detail) => {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

/*  A SYNTHETIC TRACKER built from the database under test, so this proof
 *  runs anywhere and does not depend on a workbook being present. It
 *  reproduces the four shapes that matter, including the two identity
 *  defects found in the real file. */
function buildSheet(beds) {
  const rows = [
    ["1417 N 15th"], [],
    ["Unit", "Room", "Unit Type", "Semester", "Signed/Pending", "New/Renewal",
      "Name", "Phone", "Email", "Monthly Rent"],
  ];
  beds.forEach((b) => rows.push([
    b.unitCell, b.roomCell, "2 BR, 1 BA", b.semester || "", b.status || "",
    "New", b.name || "", b.phone || "", b.email || "", b.rent == null ? null : b.rent,
  ]));
  rows.push(["Total", null, null, null, null]);
  return rows;
}

(async () => {
  const URL = receipt.harnessConnectionString();
  receipt.begin(HARNESS, { url: URL, expected: EXPECTED });
  const pool = new Pool({ connectionString: URL });

  const prop = (await pool.query(
    `select p.id, count(s.id)::int as beds from properties p
       join units u on u.property_id=p.id join spaces s on s.unit_id=u.id
      group by p.id having count(s.id) > 20 order by count(s.id) desc limit 1`)).rows[0];
  if (!prop) { console.log("  no property with enough inventory"); process.exit(2); }

  const CS = "2026-08-01", CE = "2027-07-31", LABEL = "2026–27";
  //  Real beds from inventory: some with a cycle lease, some without.
  const inv = (await pool.query(
    `select u.unit_number, s.space_label,
            exists (select 1 from leases l where l.space_id=s.id
                      and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')
                      and l.start_date <= $2::date and coalesce(l.end_date,'9999-12-31') >= $1::date) as leased
       from spaces s join units u on u.id=s.unit_id
      where u.property_id=$3 order by u.unit_number, s.space_label`, [CS, CE, prop.id])).rows;
  const ORD = { "1": "A", "2": "B", "3": "C", "4": "D" };
  const shortUnit = (u) => String(u).replace(/^\d{3,4}-(?=\d)/, "");
  const letter = (l) => ORD[String(l).replace(/\D/g, "")] || "A";
  const leased = inv.filter((r) => r.leased), free = inv.filter((r) => !r.leased);

  const sheet = buildSheet([
    //  1. tracker agrees with a canonical lease  → tied_to_lease
    { unitCell: shortUnit(leased[0].unit_number) + letter(leased[0].space_label),
      roomCell: letter(leased[0].space_label), status: "Signed", semester: "Full Year",
      name: "Agree Case", phone: "215-555-0101", email: "agree@example.com", rent: 800 },
    //  2. tracker commitment, no canonical lease → awaiting_lease (CLAIM ONLY)
    { unitCell: shortUnit(free[0].unit_number) + letter(free[0].space_label),
      roomCell: letter(free[0].space_label), status: "Signed", semester: "Full Year",
      name: "Late Signing", phone: "215-555-0102", email: "late@example.com", rent: 900 },
    //  3. tracker says open, Spine holds a lease → open_but_leased (416A shape)
    { unitCell: shortUnit(leased[1].unit_number) + letter(leased[1].space_label),
      roomCell: letter(leased[1].space_label), status: "", semester: "" },
    //  4. Unit cell and Room cell disagree → identity_conflict
    { unitCell: shortUnit(free[1].unit_number) + "A", roomCell: "B",
      status: "Pending", semester: "Fall Only",
      name: "Conflicted Id", phone: "215-555-0104", email: "conf@example.com", rent: 1100 },
    //  5. tracker open, Spine free → agrees_open, nothing claimed
    { unitCell: shortUnit(free[2].unit_number) + letter(free[2].space_label),
      roomCell: letter(free[2].space_label), status: "" },
  ]);

  ok("the parser finds the header and reads every bed row",
    parseTrackerSheet(sheet).beds.length === 5);
  ok("a row that is not a bed is reported, never dropped",
    parseTrackerSheet(sheet).unreadable.length >= 1);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const leasesBefore = (await client.query("select count(*)::int n from leases")).rows[0].n;
    const personsBefore = (await client.query("select count(*)::int n from persons")).rows[0].n;

    const out = await stageTrackerClaims(client, {
      property_id: prop.id, cycle_start: CS, cycle_end: CE, cycle_label: LABEL,
      source_label: "synthetic tracker (tests/tracker_intake.db.js)",
      source_sha256: "0".repeat(64), rows: sheet,
    });

    // ── 1. IT WRITES NO TRUTH ────────────────────────────────────────
    const leasesAfter = (await client.query("select count(*)::int n from leases")).rows[0].n;
    const personsAfter = (await client.query("select count(*)::int n from persons")).rows[0].n;
    ok("staging writes NO lease", leasesAfter === leasesBefore,
      `${leasesBefore} → ${leasesAfter}`);
    ok("staging mints NO person — a spreadsheet is not a confirmation",
      personsAfter === personsBefore, `${personsBefore} → ${personsAfter}`);
    ok("nothing is promoted", out.promoted === 0 &&
      (await client.query(
        `select count(*)::int n from proposed_records
          where target_type=$1 and promoted_record_id is not null`, [TARGET_TYPE])).rows[0].n === 0);

    // ── 2. THE FIVE OUTCOMES ─────────────────────────────────────────
    ok("a tracker row agreeing with a canonical lease ties to it",
      out.outcomes.tied_to_lease === 1, JSON.stringify(out.outcomes));
    ok("a tracker commitment with no canonical lease stays a CLAIM",
      out.outcomes.awaiting_lease === 1, JSON.stringify(out.outcomes));
    ok("tracker-open + canonical-lease is an exception, not a silent overwrite",
      out.outcomes.open_but_leased === 1);
    ok("tracker-open + no lease claims nothing",
      out.outcomes.agrees_open === 1);
    ok("every parsed bed row reaches exactly one outcome",
      Object.values(out.outcomes).reduce((a, b) => a + b, 0) === out.parsed.bed_rows);

    // ── 3. IDENTITY IS REFUSED, NOT GUESSED ──────────────────────────
    const conflict = (await client.query(
      `select status, status_reason, payload_json from proposed_records
        where target_type=$1 and payload_json->>'reconciliation'='identity_conflict'`,
      [TARGET_TYPE])).rows;
    ok("an identity conflict is refused rather than resolved by picking a column",
      out.outcomes.identity_conflict === 1 && conflict.length === 1 &&
      conflict[0].status === "needs_review" &&
      !conflict[0].payload_json.bed_key &&
      /will not choose/i.test(conflict[0].status_reason));

    // ── 4. THE CLAIM SAYS WHY IT CANNOT BE PROMOTED ──────────────────
    const awaiting = (await client.query(
      `select status, status_reason, payload_json from proposed_records
        where target_type=$1 and payload_json->>'reconciliation'='awaiting_lease'`,
      [TARGET_TYPE])).rows[0];
    ok("an awaiting-lease claim names the contractual facts it lacks",
      awaiting && Array.isArray(awaiting.payload_json.missing_for_promotion) &&
      awaiting.payload_json.missing_for_promotion.includes("start_date") &&
      awaiting.payload_json.missing_for_promotion.includes("end_date"));
    ok("…and says the cohort label is not a term",
      awaiting && /not the term/i.test(awaiting.status_reason || ""));

    // ── 5. EVERY CLAIM CARRIES ITS SOURCE ROW ────────────────────────
    const noEvidence = (await client.query(
      `select count(*)::int n from proposed_records
        where target_type=$1 and (evidence_refs = '[]'::jsonb
              or evidence_refs->0->>'source' is null
              or evidence_refs->0->>'row' is null)`, [TARGET_TYPE])).rows[0].n;
    ok("every claim names its source file and row", noEvidence === 0);

    // ── 6. THE OVERLAY DOES NOT SILENTLY SHRINK ──────────────────────
    //  THE REGRESSION THIS EXISTS FOR. The first overlay keyed on
    //  payload.space_id, so the identity-conflict claim — which has none
    //  by design — vanished from the totals and needs_review read 0.
    const r = await forwardLeasingPosition(client, {
      property_id: prop.id, cycle_start: CS, cycle_end: CE, cycle_label: LABEL });
    const op = r.operating_position;
    ok("the tracker's own committed count includes claims Spine cannot attach to a bed",
      op.per_tracker_committed === 3 && op.per_tracker_pending === 1,
      `signed ${op.per_tracker_signed} pending ${op.per_tracker_pending}`);
    ok("an unattachable claim is surfaced with its reason, never dropped",
      Array.isArray(op.unattached_claims) && op.unattached_claims.length === 1 &&
      op.unattached_claims[0].claimed_rent === 1100 &&
      /needs_review/.test(op.unattached_claims[0].status));
    ok("needs_review counts claims, not only beds the ledger could attach",
      op.needs_review >= 2, `needs_review ${op.needs_review}`);

    // ── 7. A CLAIMED RENT IS NEVER CONTRACTED RENT ───────────────────
    ok("the tracker's rent is labelled CLAIMED and kept out of canonical economics",
      /CLAIMED/.test(op.rent_basis) &&
      op.tracked_signed_rent_claims > 0 &&
      r.economics.signed_rent !== op.tracked_signed_rent_claims);

    await client.query("rollback");
  } finally { client.release(); }

  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
