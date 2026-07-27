"use strict";
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const c = await p.query("select column_name from information_schema.columns where table_name='properties' order by 1");
  console.log("properties cols: " + c.rows.map(r=>r.column_name).join(", "));
  const r = await p.query(`
    select pr.id, pr.name,
           (select count(*)::int from units u where u.property_id=pr.id) units,
           (select count(*)::int from leases l join spaces s on s.id=l.space_id join units u2 on u2.id=s.unit_id where u2.property_id=pr.id) leases,
           (select count(*)::int from assignments a where a.property_id=pr.id and a.is_active) asg,
           (select count(*)::int from comm_events ce where ce.property_id=pr.id) comms
      from properties pr order by units desc, pr.name`);
  console.log("\nTOTAL PROPERTIES: " + r.rows.length + "\n");
  for (const x of r.rows) console.log("  " + String(x.units).padStart(4) + " units | " + String(x.leases).padStart(4) + " leases | " + String(x.comms).padStart(4) + " comms | " + String(x.asg) + " asg | " + x.name + "  [" + x.id.slice(0,8) + "]");
  await p.end();
})();
