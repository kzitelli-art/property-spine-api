#!/usr/bin/env node
//  Builds the 10D scale fixture and prints the independently-computed manifest.
//
//  THIS IS THE MOST WRITE-CAPABLE SCRIPT IN THE SLICE 10 SET. It creates two
//  whole properties and roughly 110,000 spaces with their leases, schedules
//  and economic lines, and it COMMITS them. It previously read
//  HARNESS_DATABASE_URL with no refusal of any kind — so pointing it at a
//  live database was a typo away. It now resolves its target through the
//  governed helper, which refuses when host, port and database match
//  DATABASE_URL.
"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const receipt = require(path.join(__dirname, "_run_receipt"));
const F = require(path.join(__dirname, "fixtures/slice10d_scale_fixture"));

(async () => {
  const pool = new Pool({ connectionString: receipt.harnessConnectionString(), ssl: false });
  const t0 = Date.now();
  const out = await F.build(pool, { log: (m) => console.log(m) });
  console.log("built in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  const q = async (s, a = []) => (await pool.query(s, a)).rows[0];
  const sel = (await q(`select count(*) n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [out.selected_property_id])).n;
  const nb = (await q(`select count(*) n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [out.neighbour_property_id])).n;
  console.log("selected spaces:", sel, " neighbour spaces:", nb);
  console.log("manifest:", JSON.stringify(out.manifest));
  fs.writeFileSync(path.join(__dirname, "..", ".slice10d_fixture.json"), JSON.stringify(out, null, 1));
  await pool.end();
})().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
