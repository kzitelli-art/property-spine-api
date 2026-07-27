"use strict";
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rehearseVersionOne } = require("./src/money/pricing_rehearsal");
(async () => {
  const r = await rehearseVersionOne(p, {
    property_id: "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe",
    user_id: "78375274-922a-44c5-8b61-0c285d1b9911" });
  console.log("runnable: " + r.runnable + "  stopped_at: " + r.stopped_at + "  error: " + r.error);
  console.log("disposition: " + r.disposition);
  console.log("economics: " + JSON.stringify(r.economics));
  console.log("\nSTEPS:");
  for (const s of r.steps) console.log("  " + (s.passed?"PASS":"FAIL") + "  " + s.step + " — " + s.detail);
  console.log("\nACTOR ON PUBLISH: " + JSON.stringify((r.steps.find(s=>s.step==='publication_records_authority_basis')||{}).data));
  console.log("\nUNCHANGED: " + JSON.stringify(r.unchanged, null, 1));
  await p.end();
})();
