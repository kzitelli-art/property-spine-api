#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   withdrawn_context_check.js — WHO LOSES AUTHORITY AT THE NEXT DEPLOY.

   READ ONLY. It opens a `begin read only` transaction and issues SELECTs
   inside it, so the database itself refuses a write even if this file is
   later edited carelessly. It writes nothing, creates nothing, and
   changes nothing.

   ── WHAT IT IS CHECKING, AND WHAT IT IS NOT ──────────────────────────
   Until this deploy, authority_resolution.js read person_contexts with no
   `active_to` filter. A staff context that had been CLOSED still satisfied
   "is classified staff" and "is entitled to this property" — so revoking
   someone's entitlement did not revoke it for the purpose of GRANTING them
   authority. After the deploy it does.

   ONLY owner AND asset_manager ARE AFFECTED, and only at grant time.

   The first version of this script asked "who holds an active assignment
   with no open staff context" and named six people, none of whom lose
   anything. That was over-reporting, and over-reporting is not the safe
   direction: a pre-deploy check that cries wolf is one people learn to
   scroll past. Three facts narrow it:

     · authority_resolution.js governs ASSIGNABLE_ROLES — owner and
       asset_manager — and says so itself: "'X' is not an authority-bearing
       role. Only owner, asset_manager confer pricing verbs."
     · it is a DRY-RUN gate on granting, consumed only by staffbridge.js and
       orgchart.js. It is not consulted when anybody uses the product.
     · pricing_authority.js — the runtime check — contains ZERO references
       to person_contexts, so no runtime permission can change here at all.

   So a leasing, property_manager or maintenance assignment is untouched by
   this deploy no matter what its staff context looks like.

   Empty result = nobody's grantable authority changes; deploy freely.
   Any rows  = those people can no longer be GRANTED owner/asset_manager
               until a real staff context exists. They lose nothing they
               already hold.

       node tools/predeploy/withdrawn_context_check.js

   Reads DATABASE_URL from the environment, or from a .env file beside the
   repo root if one is present.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
//  Imported, never re-listed. This script must agree with the module whose
//  behaviour it is predicting; a copied set would drift and the prediction
//  would quietly stop being about the same thing.
const { FULL_AUTHORITY_ROLES } = require(path.join(ROOT, "src/money/pricing_authority.js"));

//  Convenience only: the env var wins if both are set.
let url = process.env.DATABASE_URL;
if (!url) {
  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
    if (m) url = m[1].replace(/^["']|["']$/g, "").trim();
  }
}
if (!url) {
  console.error("\n  DATABASE_URL is not set.\n");
  console.error("  PowerShell:   $env:DATABASE_URL=\"postgres://...\"");
  console.error("  bash/zsh:     export DATABASE_URL='postgres://...'\n");
  process.exit(2);
}

const pool = new Pool({ connectionString: url, ssl: databaseSsl(url) });

(async () => {
  const c = await pool.connect();
  try {
    //  The database enforces the promise in this file's header.
    await c.query("begin read only");

    const host = (() => { try { return new URL(url).hostname; } catch (_) { return "(unparseable)"; } })();
    console.log(`\n  database: ${host}`);
    console.log(`  mode:     READ ONLY — nothing here can write\n`);

    const q = await c.query(`
      select p.name        as person,
             a.role        as role,
             pr.name       as property,
             (select max(pc.active_to)
                from person_contexts pc
               where pc.person_id = a.person_id
                 and pc.context_type = 'staff') as context_closed_on
        from assignments a
        join persons    p  on p.id  = a.person_id
        join properties pr on pr.id = a.property_id
       where a.is_active
         and a.role = any($1)
         and not exists (
           select 1 from person_contexts pc
            where pc.person_id   = a.person_id
              and pc.context_type = 'staff'
              and pc.active_to    is null)
       order by pr.name, p.name`, [[...FULL_AUTHORITY_ROLES]]);

    console.log("  ── owner / asset_manager assignments WITHOUT an open staff context ──\n");
    if (!q.rows.length) {
      console.log("     none.\n");
      console.log("  VERDICT: no authority-bearing assignment is affected. Deploy freely.\n");
    } else {
      for (const r of q.rows) {
        const closed = r.context_closed_on
          ? `context closed ${new Date(r.context_closed_on).toISOString().slice(0, 10)}`
          : "never had a staff context at all";
        console.log(`     ${String(r.person).padEnd(26)} ${String(r.role).padEnd(16)} ${r.property}`);
        console.log(`     ${" ".repeat(26)} ${closed}`);
      }
      console.log(`\n  VERDICT: ${q.rows.length} assignment(s) stop conferring authority at this deploy.`);
      console.log("           That is the CORRECT outcome — they should not have had it —");
      console.log("           but decide it deliberately rather than discover it.\n");
      console.log("           To keep any of them, grant a real staff context through the");
      console.log("           governed path BEFORE deploying.\n");
    }

    await c.query("rollback");
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error("\n  FAILED:", e.message, "\n"); process.exit(1); });
