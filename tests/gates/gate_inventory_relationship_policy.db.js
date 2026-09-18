#!/usr/bin/env node
"use strict";
/*  gate_inventory_relationship_policy — every column that references
 *  units or spaces is classified, and every blocking table carries the
 *  197 trigger with the declared arguments.
 *
 *  WHY A DATABASE GATE. A foreign key added tomorrow — a new obligation
 *  table, a new money claim — would silently be able to attach operative
 *  work to retired inventory, and the review would not count it. This
 *  gate reads the live catalog, so an unclassified reference goes red on
 *  its own; it does not depend on anyone remembering the policy file.
 *
 *  Both directions:
 *    catalog → policy   every FK column (and the named non-FK references)
 *                       to units(id) / spaces(id) has a policy entry
 *    policy  → catalog  every policy entry names a real column; every
 *                       blocks_while_operative table has
 *                       trg_retired_inventory_<table> with TG_ARGV equal
 *                       to the policy's status column, terminal list and
 *                       null meaning; leases keeps the 180 trigger
 *
 *  Scope: the database this gate is pointed at (HARNESS_DATABASE_URL,
 *  the harness-isolation convention). Non-FK references are found by
 *  column NAME (unit_id, space_id, *_unit_id, *_space_id) across every
 *  table in public, so a reference that never got a constraint is still
 *  caught. */
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { POLICY, BLOCKING, triggerTables } = require("../../src/tenancy/inventory_relationship_policy");
//  The harness guard: refuses without HARNESS_DATABASE_URL and refuses a
//  target that resolves to DATABASE_URL (docs/DB_HARNESS_ISOLATION.md).
const { harnessConnectionString } = require("../_run_receipt.js");

const url = harnessConnectionString();

(async () => {
  const pool = new Pool({ connectionString: url, ssl: false });
  const failures = [];
  try {
    //  ── catalog → policy ─────────────────────────────────────────
    const fks = (await pool.query(
      `select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as ref
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid in ('units'::regclass, 'spaces'::regclass)
          and array_length(c.conkey, 1) = 1`)).rows;
    const named = (await pool.query(
      `select table_name as tbl, column_name as col from information_schema.columns
        where table_schema = 'public'
          and (column_name in ('unit_id','space_id') or column_name like '%\\_unit\\_id' or column_name like '%\\_space\\_id')
          and table_name not in ('units','spaces')`)).rows;
    //  Tables that are views or are the retirement/command ledgers themselves.
    const views = new Set((await pool.query(`select table_name from information_schema.views where table_schema='public'`)).rows.map((r) => r.table_name));
    const SELF = new Set(["inventory_correction_commands"]);
    const refs = new Map();
    for (const r of [...fks, ...named]) {
      if (views.has(r.tbl) || SELF.has(r.tbl)) continue;
      refs.set(`${r.tbl}.${r.col}`, r);
    }
    const policyKeys = new Set(POLICY.map((p) => `${p.table}.${p.column}`));
    for (const key of [...refs.keys()].sort()) {
      if (!policyKeys.has(key)) failures.push(`UNCLASSIFIED reference ${key} — add it to src/tenancy/inventory_relationship_policy.js with a treatment`);
    }
    //  ── policy → catalog ─────────────────────────────────────────
    for (const p of POLICY) {
      const col = (await pool.query(
        `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`, [p.table, p.column])).rowCount;
      if (!col) failures.push(`policy names ${p.table}.${p.column} which does not exist`);
      if (p.status_column) {
        const sc = (await pool.query(
          `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`, [p.table, p.status_column])).rowCount;
        if (!sc) failures.push(`policy status column ${p.table}.${p.status_column} does not exist`);
      }
    }
    const trg = (await pool.query(
      `select c.relname as tbl, t.tgname, pg_get_triggerdef(t.oid) as def
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and (t.tgname like 'trg_retired_inventory_%' or t.tgname = 'trg_refuse_lease_on_retired_inventory')`)).rows;
    const byTable = new Map(trg.map((t) => [t.tbl, t]));
    for (const e of triggerTables()) {
      const t = byTable.get(e.table);
      if (!t) { failures.push(`blocking table ${e.table} has no trg_retired_inventory_${e.table} trigger (migration 197)`); continue; }
      const expected = `EXECUTE FUNCTION refuse_operative_attachment_to_retired_inventory('${e.status_column || ""}', '${e.terminal.join(",")}', '${e.null_means}')`;
      if (!t.def.includes(expected)) failures.push(`trigger on ${e.table} carries different arguments than the policy: ${t.def.slice(t.def.indexOf("EXECUTE"))} vs ${expected}`);
      if (!/BEFORE INSERT OR UPDATE ON/.test(t.def)) failures.push(`trigger on ${e.table} must fire before insert or update: ${t.def}`);
    }
    if (!byTable.get("leases")) failures.push("leases has lost the 180 any-lease trigger");
    for (const t of trg) {
      if (t.tbl === "leases") continue;
      if (!BLOCKING.some((b) => b.table === t.tbl)) failures.push(`trigger ${t.tgname} on ${t.tbl} but the policy does not mark that table blocks_while_operative`);
    }
    const summary = { referencing_columns: refs.size, policy_entries: POLICY.length, blocking_tables: triggerTables().length, triggers_found: trg.length };
    if (failures.length) {
      console.error("gate_inventory_relationship_policy: FAIL", JSON.stringify(summary));
      for (const f of failures) console.error("  ✗ " + f);
      process.exit(1);
    }
    console.log("gate_inventory_relationship_policy: PASS", JSON.stringify(summary));
  } finally { await pool.end(); }
})().catch((e) => { console.error("gate_inventory_relationship_policy: ERROR", e.message); process.exit(1); });
