#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  repair_invalid_task_owners.js — stop the board naming owners who
//  cannot act.
//
//  Open tasks whose named owner no longer resolves as an eligible owner
//  are returned to UNASSIGNED through the GOVERNED path
//  (leasing_conversion._service.reassignTask with to_user_id = null), so
//  the former owner is preserved in leasing_conversion_obligation_events
//  and nothing is silently erased.
//
//  It repairs the RECORD, not the person. Whether Jordan Avery should
//  have authority at this property is an owner's decision; until it is
//  made, UNASSIGNED is the true answer and a name is the false one.
//
//  Deliberately NOT touched:
//    · closed/terminal tasks — history is not rewritten
//    · conversation ownership — this is task ownership only
//    · completion attribution — a covering manager who finished the work
//      never becomes its owner
//
//  CLASS 3 — correction tool. Dry run by default.
//  RUN:  DATABASE_URL=... node tools/repair_invalid_task_owners.js [--apply] [property_id]
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");
const PROPERTY = process.argv.find((a) => /^[0-9a-f-]{36}$/i.test(a))
  || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

(async () => {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL."); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const staffIdentity = require(path.join(__dirname, "..", "src", "identity", "staff_identity_resolver.js"));
  // The closure authority is a capability, handed only to this module — the
  // factory is its sole export. reassignTask needs its appendEvent to write
  // the history entry, so this is the real one, not a stub.
  const { createConversionClosureAuthority } =
    require(path.join(__dirname, "..", "src", "leasing", "conversion_obligation_closure.js"));
  const conversion = require(path.join(__dirname, "..", "src", "leasing", "leasing_conversion.js"))({
    pool,
    closureAuthority: createConversionClosureAuthority({ pool }),
  })._service;

  const c = await pool.connect();
  const bar = "─".repeat(66);
  console.log(`\n${bar}\nINVALID TASK OWNERS${APPLY ? "" : "  (dry run)"}\n${bar}`);

  try {
    await c.query("begin");

    const open = (await c.query(
      `select lco.obligation_id, lco.owner_user_id, lco.rung, u.name as owner_name,
              o.type, o.label
         from leasing_conversion_obligations lco
         join leasing_conversions lc on lc.id = lco.conversion_id
         join obligations o on o.id = lco.obligation_id
         left join users u on u.id = lco.owner_user_id
        where lc.property_id = $1 and lco.outcome is null
          and lco.owner_user_id is not null
        order by o.created_at`, [PROPERTY])).rows;

    console.log(`open tasks with a named owner: ${open.length}\n`);

    let repaired = 0, fine = 0;
    for (const t of open) {
      const idn = await staffIdentity.resolveStaffIdentity(c, {
        user_id: t.owner_user_id, property_id: PROPERTY,
      });
      if (idn.state === "resolved") {
        fine++;
        console.log(`  KEEP     ${String(t.type).padEnd(28)} ${t.owner_name}`);
        continue;
      }
      console.log(`  REPAIR   ${String(t.type).padEnd(28)} ${t.owner_name}  →  UNASSIGNED`);
      console.log(`           reason: ${idn.state} (${idn.basis})`);
      try {
        await conversion.reassignTask(c, {
          obligation_id: t.obligation_id,
          by_user_id: null,
          to_user_id: null,
          reason: "owner_not_eligible",
          idempotency_key: `repair-owner-${t.obligation_id}`,
        });
        repaired++;
      } catch (e) {
        console.error(`           FAILED: ${e.publicMessage || e.message}`);
      }
    }

    console.log(`\n${bar}`);
    console.log(`already valid: ${fine}    repaired: ${repaired}`);
    if (!APPLY) {
      await c.query("rollback");
      console.log(`\nDRY RUN — rolled back. Re-run with --apply to commit.`);
    } else {
      await c.query("commit");
      console.log(`\nCOMMITTED. Former owners preserved in the reassignment history.`);
    }
    console.log(`${bar}\n`);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error("failed, rolled back:", e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end().catch(() => {}); }
})();
