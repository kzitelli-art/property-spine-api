#!/usr/bin/env node
/* Applies the migration-137 candidate to the isolated baseline, the same
   way migrate.js does: one transaction carrying the DDL AND the ledger
   row. Used by falsify.js, which needs schema 137 present but does not
   need the timing and lock measurements prove.js performs.

   ⚠ ISOLATED POSTGRES ONLY — refuses without the harness sentinel. */
"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const URL = process.env.FALSIFY_DATABASE_URL || process.env.PROVE_DATABASE_URL;
(async () => {
  if (!URL) { console.error("REFUSED: no isolated DATABASE URL set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const n = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (n !== 1) { console.error("REFUSED: harness sentinel absent."); process.exit(2); }

  const ceiling = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (ceiling === "137") { console.log("already at 137"); await c.end(); return; }
  if (ceiling !== "136") { console.error("REFUSED: ledger is " + ceiling + ", expected 136."); process.exit(1); }

  const sql = fs.readFileSync(path.join(__dirname, "..", "..",
    "migrations/137_release_0_completion_proof.sql"), "utf8");
  await c.query("begin");
  await c.query(sql);
  await c.query(`insert into schema_migrations (version,name) values ('137','release_0_completion_proof')`);
  await c.query("commit");
  console.log("applied 137");
  await c.end();
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
