#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   MIGRATION 142 — THE VALIDATE PREFLIGHT

   `ck_oblig_acceptance_has_owner` ships NOT VALID: it binds every future
   write immediately without asserting anything about history. This
   answers the only question that stands between that and VALIDATE —
   does any existing row violate it?

       node tools/build1/preflight_142_orphaned_acceptance.js
       node tools/build1/preflight_142_orphaned_acceptance.js --json

   ── IT DOES NOT REPAIR ANYTHING ────────────────────────────────────

   An orphaned acceptance can be corrected two ways — restore the
   assignment, or clear the acceptance — and they say different things
   about what happened. That is a human judgement about history, and a
   migration that guessed would be writing a story rather than recording
   one. So this reports the exact set and stops.

   ── READ-ONLY BY CONSTRUCTION ──────────────────────────────────────

   `BEGIN TRANSACTION READ ONLY`, enforced by the server, rolled back.
   Same discipline as the Release 0 preflight and the acceptance receipt.

   exit 0  no violations — VALIDATE is safe
   exit 1  violations exist — the exact set is printed; do not guess
   exit 2  could not read
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");

const URL = process.env.DATABASE_URL;
const AS_JSON = process.argv.includes("--json");

const VALIDATE_SQL =
  "alter table public.obligations validate constraint ck_oblig_acceptance_has_owner;";

(async function main() {
  if (!URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(2); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) {
    console.error("REFUSED: could not connect — " + e.message); process.exit(2); }
  await c.query("begin transaction read only");

  //  Is the constraint even here? Reporting "zero violations" against a
  //  database that never got the migration would be a confident wrong
  //  answer about the thing this exists to check.
  const con = (await c.query(
    `select convalidated from pg_constraint
      where conname = 'ck_oblig_acceptance_has_owner'
        and conrelid = 'public.obligations'::regclass`)).rows[0];

  if (!con) {
    const out = { constraint: "absent",
      why: "migration 142 has not been applied here. Apply it before validating." };
    console.log(AS_JSON ? JSON.stringify(out, null, 2)
      : "\n  ⛔ ck_oblig_acceptance_has_owner is ABSENT — migration 142 is not applied.\n");
    await c.query("rollback"); await c.end(); process.exit(1);
  }

  const rows = (await c.query(
    `select o.id                    as obligation_id,
            o.property_id,
            p.name                  as property_name,
            o.module, o.type,
            o.assigned_user_id,
            o.accepted_by_user_id,
            u.name                  as accepted_by_name,
            o.accepted_at,
            o.status
       from public.obligations o
       left join public.properties p on p.id = o.property_id
       left join public.users u      on u.id = o.accepted_by_user_id
      where o.accepted_by_user_id is not null
        and o.assigned_user_id is null
      order by o.property_id, o.accepted_at`)).rows;

  const result = {
    constraint: con.convalidated ? "already_validated" : "not_valid",
    violations: rows.length,
    rows,
    next_step: rows.length === 0
      ? (con.convalidated ? "nothing to do — already validated" : VALIDATE_SQL)
      : "STOP. Each row is a human judgement: restore the assignment, or clear the " +
        "acceptance. They say different things about what happened, and this tool " +
        "does not choose.",
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    await c.query("rollback"); await c.end();
    process.exit(rows.length === 0 ? 0 : 1);
  }

  const bar = "═".repeat(70);
  console.log(`\n${bar}\n  MIGRATION 142 — VALIDATE PREFLIGHT   (read-only)\n${bar}\n`);
  console.log(`  constraint                 ${result.constraint}`);
  console.log(`  orphaned acceptances       ${rows.length}\n`);

  if (rows.length === 0) {
    console.log("  ✓ No acceptance exists without an assignee. VALIDATE is safe:\n");
    console.log(`      ${VALIDATE_SQL}\n`);
  } else {
    console.log("  ⛔ These rows would prevent VALIDATE. Each is an acceptance recorded");
    console.log("     against nobody — a person is on record as having taken work that");
    console.log("     is assigned to no one.\n");
    for (const r of rows) {
      console.log(`    obligation  ${r.obligation_id}`);
      console.log(`      property  ${r.property_id}  ${r.property_name || ""}`);
      console.log(`      module    ${r.module} / ${r.type}`);
      console.log(`      assigned  ${r.assigned_user_id || "— (this is the defect)"}`);
      console.log(`      accepted  ${r.accepted_by_user_id} ${r.accepted_by_name || ""} at ${r.accepted_at}`);
      console.log(`      status    ${r.status}\n`);
    }
    console.log("  " + result.next_step.replace(/(.{68}) /g, "$1\n  ") + "\n");
  }
  console.log(`${bar}\n`);
  await c.query("rollback"); await c.end();
  process.exit(rows.length === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
