"use strict";
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ORPHAN = "8d1ce2a1-29f2-490c-a861-3b73c68a2da7";
(async () => {
  const c = await p.connect();
  await c.query("begin");
  // Remove the STAFF CONTEXT: this is what makes a person selectable as a
  // staff authority subject. Without it the row cannot receive authority.
  const ctx = await c.query("delete from person_contexts where person_id=$1 returning id",[ORPHAN]);
  // Label it unmistakably. This row was created 32 seconds before its
  // replacement by a re-run and carries ZERO business history; the bridge
  // audit legitimately references it, so it is retained rather than deleted.
  const nm = await c.query(
    `update persons set name=$2, email=null
      where id=$1 returning id,name,email,source`,
    [ORPHAN, "VOID — duplicate staff record created in error 2026-07-27, superseded by c1dedf39"]);
  await c.query("commit"); c.release();
  console.log("staff contexts removed: " + ctx.rowCount);
  console.log("relabelled: " + JSON.stringify(nm.rows[0]));

  const staffNow = await p.query(
    `select pe.id, pe.name from person_contexts pc join persons pe on pe.id=pc.person_id
      where pc.context_type='staff' and pe.email='kz8434@gmail.com'`);
  console.log("\nstaff persons holding that email: " + JSON.stringify(staffNow.rows));
  await p.end();
})();
