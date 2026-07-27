#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  retire_hollow_leases.js — free the units blocked by leases that never
//  became tenancies.
//
//  A hollow lease is `pending`, names no resident, came from no
//  application, and has no activated economic tenancy. It blocks Confirm
//  Term on its space and reports nothing: the executed lease is recorded,
//  admission returns overlapping_operative_lease, the application never
//  reaches accepted_term_required, and confirm-term refuses with one
//  opaque 403 four layers from the cause.
//
//  Goes through voidHollowLease, so every refusal this tool cannot see is
//  still enforced by the service, and every void is recorded as an event
//  naming the actor and the prior status. Nothing is deleted.
//
//  CLASS 3 — correction tool. Dry run by default.
//  RUN:  DATABASE_URL=... node tools/retire_hollow_leases.js --actor <uuid> [--apply] [property_id]
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");
const svc = require(path.join(__dirname, "..", "src", "tenancy", "lease_void_service.js"));

const APPLY = process.argv.includes("--apply");
const ai = process.argv.indexOf("--actor");
const ACTOR = ai > -1 ? process.argv[ai + 1] : null;
const PROPERTY = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/i.test(a) && a !== ACTOR)[0]
  || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

(async () => {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL."); process.exit(2); }
  if (!ACTOR) {
    console.error("--actor <uuid> is required. Retiring a lease is an attested act;");
    console.error("the service refuses an anonymous one, and so does this tool.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const bar = "─".repeat(70);
  console.log(`\n${bar}\nHOLLOW LEASES${APPLY ? "" : "  (dry run)"}\n${bar}`);

  try {
    await c.query("begin");

    const rows = (await c.query(
      `select l.id, l.lease_status, l.start_date, l.end_date, u.unit_number
         from leases l
         join spaces s on s.id = l.space_id
         join units u on u.id = s.unit_id
        where l.property_id = $1
          and l.lease_status not in ('cancelled','terminated','rescinded','void','expired','superseded')
          and coalesce(array_length(l.tenant_ids,1),0) = 0
          and l.application_id is null
          and l.economic_tenancy_activated_at is null
        order by u.unit_number`, [PROPERTY])).rows;

    console.log(`blocking leases with no resident, no application, no money: ${rows.length}\n`);
    let done = 0;
    for (const r of rows) {
      try {
        const out = await svc.voidHollowLease(c, {
          lease_id: r.id, actor_user_id: ACTOR, reason: "created_in_error",
          reason_detail: "hollow lease blocking Confirm Term on this unit",
        });
        done++;
        console.log(`  unit ${String(r.unit_number).padEnd(6)} ${out.prior_status} → cancelled   ${r.id}`);
      } catch (e) {
        console.error(`  unit ${String(r.unit_number).padEnd(6)} REFUSED (${e.code}): ${e.publicMessage || e.message}`);
      }
    }

    console.log(`\n${bar}`);
    console.log(`retired: ${done} of ${rows.length}`);
    if (!APPLY) { await c.query("rollback"); console.log(`\nDRY RUN — rolled back. Re-run with --apply.`); }
    else { await c.query("commit"); console.log(`\nCOMMITTED. Each void is recorded as a 'lease_voided' event.`); }
    console.log(`${bar}\n`);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error("failed, rolled back:", e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end().catch(() => {}); }
})();
