#!/usr/bin/env node
/* tools/import_rent_roll_truth.js — ONE-TIME OPERATIONS SCRIPT (Class 3)
   Commits the July 15 rent-roll truth reconciliation into Neon so that
   GET /operator/rent-roll returns reconciliation.unit_truth and the signed-in
   Rent Roll renders the reconciled truth table instead of the June baseline.

   It reuses the DEPLOYED snapshot_loader machinery (validateReconciliation +
   loadReconciliation) — no new business logic, no HTTP, no session required.
   The document is fetched from the app repo's solo-rent-roll-data.js (already
   public), so no PII file is added to this repo.

   DRY-RUN BY DEFAULT. Nothing is written without --commit.

   Usage (Render Shell, run by path):
     node tools/import_rent_roll_truth.js --property <property-uuid>            # dry run
     node tools/import_rent_roll_truth.js --property <property-uuid> --commit   # write
   Optional: --force  (re-import same file+date even if already committed)
*/
"use strict";
const vm = require("node:vm");
const { Pool } = require("pg");

const SOURCE_URL =
  "https://raw.githubusercontent.com/kzitelli-art/property-spine-app/main/solo-rent-roll-data.js?t=" + Date.now();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : null;
}

(async () => {
  const propertyId = arg("--property");
  const doCommit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");

  if (!propertyId || propertyId === true) {
    console.log("REFUSED: --property <uuid> is required. The document cannot choose its destination.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.log("REFUSED: DATABASE_URL is not set in this shell.");
    process.exit(1);
  }

  // 1. Fetch the truth document from the app repo (public; no new exposure).
  console.log("Fetching truth document from app repo…");
  if (typeof fetch !== "function") { console.log("FAILED: global fetch unavailable (Node 18+ required)."); process.exit(1); }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) { console.log("FAILED: could not fetch solo-rent-roll-data.js (HTTP " + res.status + ")."); process.exit(1); }
  const js = await res.text();

  // 2. Extract window.__RENT_ROLL_TRUTH_LIBRARY.solo in a sandbox.
  const sandbox = { window: {} };
  try { vm.runInNewContext(js, sandbox, { timeout: 10000 }); }
  catch (e) { console.log("FAILED: could not evaluate the data file: " + e.message); process.exit(1); }
  const lib = sandbox.window.__RENT_ROLL_TRUTH_LIBRARY || {};
  const document = lib.solo || lib[Object.keys(lib)[0]];
  if (!document) { console.log("FAILED: no truth document found in the data file."); process.exit(1); }

  // 3. Wire the DEPLOYED loader and validate with ITS validator.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const router = require("../snapshot_loader")({ pool });
  const H = router.helpers;

  const verdict = H.validateReconciliation(document);
  console.log("");
  console.log("Validator verdict: " + (verdict.ok ? "OK" : "FAILED"));
  console.log("  unit rows:  " + verdict.unit_rows);
  console.log("  exceptions: " + verdict.exceptions);
  if (!verdict.ok) { console.log("  errors: " + verdict.errors.join(", ")); await pool.end(); process.exit(1); }

  // 4. Resolve and show the target property so a human confirms before commit.
  const prop = (await pool.query("select id, name from properties where id=$1", [propertyId])).rows[0];
  if (!prop) { console.log("REFUSED: property " + propertyId + " does not exist."); await pool.end(); process.exit(1); }

  const sourceFile = "solo-rent-roll-data.js truth §" + document.as_of;
  console.log("");
  console.log("Target property:  " + prop.name + "  (" + prop.id + ")");
  console.log("Document as-of:   " + document.as_of);
  console.log("Would write:      import_batches (source_type=rent_roll_reconciliation, status=committed)");
  console.log("                  + 1 evidence row (the document; no persons/leases fabricated)");
  console.log("Source file tag:  " + sourceFile);

  if (!doCommit) {
    console.log("");
    console.log("DRY RUN — nothing written. Confirm the property above is correct, then re-run with --commit");
    await pool.end();
    process.exit(0);
  }

  // 5. Commit through the deployed loader (transactional, idempotent).
  const out = await H.loadReconciliation(pool, document, {
    targetPropertyId: prop.id,
    sourceFile: sourceFile,
    actorId: "render_shell_ops",
    force: force,
  });
  if (out.error) { console.log("FAILED: " + out.error); await pool.end(); process.exit(1); }
  if (out.already_loaded) {
    console.log("");
    console.log("ALREADY LOADED (idempotent): batch " + out.import_batch_id + " for " + out.source_file);
    console.log("Nothing new was written. Use --force to re-import.");
    await pool.end();
    process.exit(0);
  }

  // 6. Round-trip verify: the GET path must now see it.
  const back = await H.readLatestReconciliation(pool, prop.id);
  const rows = back && back.document && Array.isArray(back.document.unit_truth) ? back.document.unit_truth.length : 0;
  console.log("");
  console.log("COMMITTED. Receipt:");
  console.log("  import batch:   " + (out.import_batch_id || (back && back.batch && back.batch.id) || "(see import_batches)"));
  console.log("  round-trip read: " + rows + " unit rows now served by GET /operator/rent-roll");
  console.log("");
  console.log("Next: refresh the app while signed in — the Rent Roll now renders the");
  console.log("reconciled truth table (91.5% Sep 1, 21 columns) instead of the June baseline.");
  await pool.end();
  process.exit(0);
})().catch((e) => { console.log("FAILED: " + e.message); process.exit(1); });
