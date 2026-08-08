#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 2 — POST-MIGRATION INVARIANT READ

   One short command for the deployed checkout. Read-only: it proves the
   migration landed and that nothing else moved with it.

   Deliberately not a heredoc. The transport build established that a
   script needed under pressure must be committed, not pasted.

   usage:  node tools/steps23/verify_137_applied.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } =
  require(path.join(__dirname, "..", "activation", "_readonly.js"));

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

(async function main() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "verify_137");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  console.log("STEP 2 — POST-MIGRATION INVARIANTS  (read-only proven)\n");

  const v = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("L1  ledger ceiling is 137", v === "137", String(v));

  const t = Number((await c.query(
    `select count(*) n from information_schema.tables where table_schema='public'
      and table_name in ('work_order_proof_evaluations','work_order_proof_evaluation_attachments',
                         'release_0_activation_history','release_0_legacy_cutover_inventory')`)).rows[0].n);
  ok("L2  all four tables exist", t === 4, String(t));

  const views = Number((await c.query(
    `select count(*) n from information_schema.views where table_schema='public'
      and table_name in ('work_order_proof_evaluation_head','release_0_activation_current')`)).rows[0].n);
  ok("L3  both head views exist", views === 2, String(views));

  const trg = Number((await c.query(
    `select count(*) n from pg_trigger where not tgisinternal
      and tgname in ('chain_guard_wope','no_update_wope','no_delete_wope',
                     'chain_guard_r0ah','no_update_r0ah','no_delete_r0ah',
                     'no_update_wopea','no_delete_wopea','no_update_r0lci','no_delete_r0lci')`)).rows[0].n);
  ok("L4  all ten append-only / chain triggers are installed", trg === 10, String(trg));

  const idx = Number((await c.query(
    `select count(*) n from pg_indexes where schemaname='public'
      and indexname in ('uq_wope_genesis','uq_wope_one_successor','uq_r0ah_genesis','uq_r0ah_one_successor')`)).rows[0].n);
  ok("L5  all four chain race indexes exist", idx === 4, String(idx));

  //  NOTHING SHOULD HAVE MOVED. The migration is additive: it creates
  //  objects and writes no rows. A non-empty evaluation table straight
  //  after the migration would mean something else wrote during it.
  const rows = Number((await c.query(
    `select (select count(*) from work_order_proof_evaluations)
          + (select count(*) from work_order_proof_evaluation_attachments)
          + (select count(*) from release_0_activation_history)
          + (select count(*) from release_0_legacy_cutover_inventory) n`)).rows[0].n);
  ok("L6  the migration wrote NO rows — it is additive only", rows === 0, String(rows));

  //  Activation is a LATER step. If a row exists here, the sequence has
  //  been jumped and the cutover inventory would capture the wrong world.
  const act = Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n);
  ok("L7  no activation row exists yet (that is a later step)", act === 0, String(act));

  console.log(`\n  passed ${pass}   failed ${fail}`);
  if (fail) console.log("\n  ⚠ Investigate before deploying the Step 3 writer.");
  else console.log("\n  Schema 137 is in place and inert. The old API runs against it unchanged.");
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
