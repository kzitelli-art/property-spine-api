#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  never_delete_guard_proof.js — asserts the Demo Building cleanup guard.
//
//  WHY THIS EXISTS
//  Demo Building (a50fbdd0-…) holds the only irreplaceable record in the
//  system — Marlow's 2026-07-05 tour 31ca5801-… — plus the entire demo
//  corpus (344 leases, 431 comm_events, 15 tours, open tour_availability).
//  `POST /owner/cleanup {confirm:"DELETE"}` deletes properties and CASCADES
//  leases/events/tours. Before this guard, Demo Building was spared only
//  because its NAME does not match TEST_PATTERNS — a naming coincidence.
//  A rename, or a newly-added pattern, would have cascaded all of it away.
//
//  EVIDENCE STANDARD
//  This asserts against the ACTUAL constant in src/surfaces/owner.js source
//  (not a copy) and against the LIVE deletable set. It is falsifiable:
//  running it against pre-guard source fails assertion 1. Proven by:
//      git show main:src/surfaces/owner.js > /tmp/old.js  (before the merge)
//  READ-ONLY. Executes only SELECTs. Never deletes. Never calls owner/cleanup.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const MARLOW_TOUR = "31ca5801-a851-4be5-802d-28739f24d6e1";
const OWNER_SRC = process.env.OWNER_SRC ||
  path.join(__dirname, "..", "..", "src", "surfaces", "owner.js");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "  — " + detail : ""}`); }
}

// Parse the real constants out of the real source file.
function parseArray(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return null;
  return (m[1].match(/"[^"]*"|'[^']*'/g) || []).map(s => s.slice(1, -1));
}

(async () => {
  console.log("═══ NEVER_DELETE guard proof ═══");
  console.log("source:", OWNER_SRC);
  const src = fs.readFileSync(OWNER_SRC, "utf8");

  const neverDelete = parseArray(src, "NEVER_DELETE");
  const testPatterns = parseArray(src, "TEST_PATTERNS");
  check("NEVER_DELETE parsed from source", Array.isArray(neverDelete) && neverDelete.length > 0);
  check("TEST_PATTERNS parsed from source", Array.isArray(testPatterns) && testPatterns.length > 0);

  // 1. THE ASSERTION THAT FAILS ON PRE-GUARD SOURCE.
  check("Demo Building is in NEVER_DELETE (the guard)",
    !!neverDelete && neverDelete.includes(DEMO),
    "a50fbdd0-… absent — cleanup could cascade Marlow + the demo corpus");

  // 2. The previously-protected real properties must remain protected.
  ["260b6bac-4738-47c4-b86d-511b726adc48",
   "9e2bb96e-08e2-41db-81c2-91055ceb50a3",
   "971c51ab-be96-4e5f-81df-0e59804c879b"].forEach(id => {
    check(`pre-existing protection retained: ${id.slice(0, 8)}…`,
      !!neverDelete && neverDelete.includes(id));
  });

  if (!process.env.DATABASE_URL) {
    console.log("\n  (DATABASE_URL unset — skipping live checks)");
    console.log(`\n═══ ${pass} passed · ${fail} failed ═══`);
    process.exit(fail === 0 ? 0 : 1);
  }

  const useSsl = /sslmode=require/.test(process.env.DATABASE_URL);
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: useSsl ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    // 3. Reproduce findDeletable() EXACTLY (read-only) and assert Demo is absent.
    const rows = (await c.query(
      `select id, name from properties
        where id <> all($1::uuid[])
          and (` + testPatterns.map((_, i) => `name ilike $${i + 2}`).join(" or ") + `)
        order by name`,
      [neverDelete, ...testPatterns])).rows;
    console.log(`\n  live deletable set: ${rows.length} propert${rows.length === 1 ? "y" : "ies"}`);
    rows.forEach(r => console.log(`     - ${r.name} (${r.id})`));
    check("Demo Building is NOT in the live deletable set",
      !rows.some(r => r.id === DEMO));

    // 4. THE HAZARD SIMULATION — the id guard must hold even if the name matches.
    //    Proves protection comes from the whitelist, not from naming luck.
    const hazard = (await c.query(
      `select id from properties where id = $1 and id <> all($2::uuid[])`,
      [DEMO, neverDelete])).rows;
    check("even a name-pattern match could not select Demo Building (id guard holds)",
      hazard.length === 0);

    // 5. The record the guard exists for.
    const m = (await c.query(
      `select id, property_id, status from leasing_tours where id = $1`, [MARLOW_TOUR])).rows[0];
    check("Marlow's tour is intact", !!m, "MISSING");
    check("Marlow's tour is on Demo Building (the property this guard protects)",
      !!m && m.property_id === DEMO, m ? m.property_id : "n/a");
  } finally {
    await c.end();
  }

  console.log(`\n═══ ${pass} passed · ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("CRASH:", e.message); process.exit(2); });
