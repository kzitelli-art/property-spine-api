"use strict";
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const c = await p.query("select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='persons'::regclass and contype='c'");
  console.log("persons CHECK constraints: " + JSON.stringify(c.rows));
  const l = await p.query("select lifecycle_status, count(*)::int n from persons group by 1 order by 2 desc");
  console.log("lifecycle values in use: " + JSON.stringify(l.rows));
  const cols = await p.query("select column_name from information_schema.columns where table_name='persons' order by 1");
  console.log("persons cols: " + cols.rows.map(r => r.column_name).join(", "));
  const pcc = await p.query("select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='person_contexts'::regclass");
  console.log("\nperson_contexts constraints: " + JSON.stringify(pcc.rows.map(x=>x.def)));
  await p.end();
})();
