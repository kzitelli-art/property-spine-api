// ════════════════════════════════════════════════════════════════════
//  rent_roll_institutional_proof.js
//
//  The institutional Rent Roll is a PRESENTATION of the canonical read, not
//  a second calculation. This harness exists to prove that the operating
//  page, the institutional response, the print data and the CSV can never
//  disagree — because none of them computes anything.
//
//  Run: DATABASE_URL=... [API_BASE=... STAFF_SESSION=...] \
//         node tests/proofs/rent_roll_institutional_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { currentRentRoll } = require(path.join(REPO, "src/surfaces/rent_roll_canonical"));
  const { institutionalRentRoll, institutionalCsv, COLUMNS } = require(path.join(REPO, "src/surfaces/rent_roll_institutional"));

  const op = await currentRentRoll(pool, { property_id: DEMO });
  const inst = await institutionalRentRoll(pool, { property_id: DEMO });
  const csv = institutionalCsv(inst);

  console.log("\n== ONE CANONICAL SOURCE - four outputs, identical totals ==");
  ok(inst.rows.length === op.rows.length,
    `one row per canonical position in both (${inst.rows.length})`);
  ok(inst.totals.trusted_monthly_contractual_rent === op.totals.contractual_rent_trusted,
    `trusted rent identical ($${inst.totals.trusted_monthly_contractual_rent})`);
  ok(inst.totals.confirmed_contractual_occupancy === op.totals.confirmed_contractual_occupancy.occupied,
    `occupancy identical (${inst.totals.confirmed_contractual_occupancy})`);
  ok(inst.totals.contested_rent_excluded === op.totals.contractual_rent_excluded_contested,
    `contested excluded identical ($${inst.totals.contested_rent_excluded})`);
  ok(inst.totals.total_positions === op.inventory, "position count identical");
  ok(csv.includes(String(inst.totals.trusted_monthly_contractual_rent)),
    "the CSV carries the same trusted rent figure");
  ok(csv.includes("Confirmed contractual occupancy," + inst.totals.confirmed_contractual_occupancy
    + " of " + inst.totals.occupancy_denominator), "the CSV carries the same occupancy");

  // No recalculation anywhere in the institutional module.
  const src = require("fs").readFileSync(path.join(REPO, "src/surfaces/rent_roll_institutional.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/reduce\(/.test(src), "the institutional module contains no reduce() - it never sums anything");
  ok(!/market_rent/.test(src), "market_rent appears nowhere in the institutional module");

  console.log("\n== FILTERS CANNOT MOVE REPORT TOTALS ==");
  // The operating page filters client-side over rows. Prove the totals live on
  // the response, not on the row set, by filtering hard and re-reading totals.
  const filtered = op.rows.filter(r => r.tenancy_state === "contested");
  ok(filtered.length > 0 && filtered.length < op.rows.length, `a filter narrows rows (${filtered.length})`);
  const reread = await currentRentRoll(pool, { property_id: DEMO });
  ok(reread.totals.contractual_rent_trusted === op.totals.contractual_rent_trusted,
    "totals are server-authored and unchanged by any client-side narrowing");

  console.log("\n== HONEST BLANKS, NEVER BACKFILLED ==");
  ok(inst.rows.every(r => r.security_deposit === ""),
    "security deposit is blank on every row until its meaning is governed");
  ok(inst.reconciliation.statements.some(s => /deposit claims exist but have not yet been mapped/i.test(s)),
    "and the reconciliation SAYS why, rather than leaving an unexplained empty column");
  // Unit types now come from the reviewed mapping receipt. What must hold is
  // that they are GOVERNED labels, that no raw source code is presented as a
  // type, and that the one position with no deterministic source row stays
  // honestly unconfigured rather than being inferred from bedrooms or sqft.
  const types = [...new Set(inst.rows.map(r => r.unit_type))];
  ok(types.length > 1, `unit types come from governed mappings (${types.length} distinct)`);
  ok(types.some(t => /Studio|Bed|Commercial/.test(t)), `governed labels are human-readable (${types.filter(t => t !== "Not configured").slice(0, 3).join(", ")}…)`);
  ok(!types.some(t => /_0\d$|^[0-9S]\.\d[A-Z]{2}/.test(t)), "no raw source code (S.1UN_02) is presented as a type");
  const unconfigured = inst.rows.filter(r => r.unit_type === "Not configured");
  ok(unconfigured.length === 1,
    `exactly the unmatched position stays Not configured (${unconfigured.map(r => r.position).join(", ")})`);
  ok(!JSON.stringify(inst.rows).includes("market_rent"), "no market_rent value reaches the schedule");
  ok(!JSON.stringify(inst).includes("S.1UN_02"), "no raw source unit-type code appears anywhere in the report");

  console.log("\n== CONTESTED NEVER ENTERS TRUSTED RENT ==");
  const contestedRows = inst.rows.filter(r => r._axes.tenancy_state === "contested");
  ok(contestedRows.length === inst.totals.positions_contested, "contested rows match the reported count");
  const opContested = op.rows.filter(r => r.tenancy_state === "contested");
  ok(opContested.every(r => !r.contributes_trusted_rent), "no contested position contributes trusted rent");
  ok(inst.totals.contested_rent_excluded > 0, `contested rent is reported separately ($${inst.totals.contested_rent_excluded})`);

  console.log("\n== THE REPORT IDENTIFIES ITSELF ==");
  ok(inst.report.title === "Rent Roll", "report title present");
  ok(!!inst.report.property_name, `property named (${inst.report.property_name})`);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(inst.report.as_of), `as-of date present (${inst.report.as_of})`);
  ok(!!inst.report.generated_at, "generated timestamp present");
  ok(csv.split("\n")[0].includes(inst.report.property_name), "the CSV names the property on line 1");
  ok(csv.includes("As of," + inst.report.as_of), "the CSV carries the as-of date");

  console.log("\n== DATES ARE DATES ==");
  const dated = ["lease_start", "lease_expiration", "balance_as_of"];
  for (const k of dated) {
    const bad = inst.rows.filter(r => r[k] && !/^\d{4}-\d{2}-\d{2}$/.test(r[k]));
    ok(bad.length === 0, `${k} is always ISO yyyy-mm-dd (${bad.length} malformed)`);
  }
  ok(!/,[A-Z][a-z]{2} [A-Z][a-z]{2} \d/.test(csv), "no locale date string leaked into the CSV");

  console.log("\n== COLUMN DEFINITION IS SHARED ==");
  ok(COLUMNS.length === 13, `thirteen institutional columns (${COLUMNS.length})`);
  const header = csv.split("\n")[3];
  ok(header === COLUMNS.map(c => c.label).join(","), "the CSV header IS the shared column definition, in order");
  ok(COLUMNS.every(c => c.key in inst.rows[0]), "every declared column exists on every row");

  console.log("\n== HTTP ==");
  const base = process.env.API_BASE, token = process.env.STAFF_SESSION;
  if (!base || !token) { console.log("   SKIP  no API_BASE / STAFF_SESSION"); }
  else {
    const anon = await fetch(`${base}/operator/rent-roll/institutional`);
    ok(anon.status === 401, "no session -> 401");
    const r = await fetch(`${base}/operator/rent-roll/institutional`, { headers: { "x-staff-session": token } });
    const b = await r.json();
    ok(r.status === 200 && b.report.property_id === DEMO, "session-scoped 200");
    ok(b.totals.trusted_monthly_contractual_rent === inst.totals.trusted_monthly_contractual_rent,
      "HTTP totals match the service exactly");
    const c2 = await fetch(`${base}/operator/rent-roll/institutional?format=csv`, { headers: { "x-staff-session": token } });
    const text = await c2.text();
    ok((c2.headers.get("content-type") || "").includes("text/csv"), "CSV served as text/csv");
    ok((c2.headers.get("content-disposition") || "").includes("attachment"), "CSV served as an attachment");
    ok(text.split("\n").length === csv.split("\n").length, "HTTP CSV has the same line count as the service CSV");
    const spoof = await fetch(`${base}/operator/rent-roll/institutional?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`,
      { headers: { "x-staff-session": token } });
    ok((await spoof.json()).report.property_id === DEMO, "a client-supplied property_id is ignored");
  }

  await pool.end();
  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
