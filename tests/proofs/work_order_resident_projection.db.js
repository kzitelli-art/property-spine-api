/* ════════════════════════════════════════════════════════════════════
   WHO IS THIS WORK ORDER ABOUT — the six cases.

   The first version of this projection asked one question, "who holds the
   active lease", and silently assumed the answer was one person. Roommates,
   by-bed properties, corrected leases and common-area work all make that
   unsafe, and none of it would have thrown — it would have quietly named
   somebody. These six cases exist so it cannot happen again.

     HARNESS_DATABASE_URL=postgres://... node tests/proofs/work_order_resident_projection.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("../_run_receipt");
const { readWorkOrderStatus } = require("../../src/surfaces/work_order_status_read");

const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL });
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   ", n); }
  else { fail++; console.log("  FAIL ", n); if (d) console.log("        " + d); } };

(async () => {
  const c = pool;
  const org = (await c.query(`insert into organizations (name) values ('R') returning id`)).rows[0].id;
  const prop = (await c.query(`insert into properties (name, organization_id) values ('P', $1) returning id`, [org])).rows[0].id;
  const other = (await c.query(`insert into properties (name, organization_id) values ('Q', $1) returning id`, [org])).rows[0].id;
  //  REAL SCHEMA. persons has no property_id (a person is durable, §12) and
  //  leases anchor to a SPACE, not a unit. This proof used to insert into
  //  both phantom columns and could never have run on a migration-built
  //  database — which is how the read it guards stayed broken.
  const person = async (name) => (await c.query(
    `insert into persons (name) values ($1) returning id`, [name])).rows[0].id;
  const unit = async (n, p = prop) => (await c.query(
    `insert into units (property_id, unit_number) values ($1,$2) returning id`, [p, n])).rows[0].id;
  const spaceOf = async (u) => (await c.query(
    `select id from spaces where unit_id = $1 order by created_at asc limit 1`, [u])).rows[0].id;
  const wo = async (u, affected) => (await c.query(
    `insert into work_orders (property_id, unit_id, affected_person_id, title, status)
     values ($1,$2,$3,'t','open') returning id`, [prop, u, affected])).rows[0].id;
  const lease = async (u, ids, status = "active", p = prop) => c.query(
    `insert into leases (property_id, space_id, tenant_ids, lease_status)
     values ($1,$2,$3,$4)`, [p, await spaceOf(u), ids, status]);
  const read = async (id) => readWorkOrderStatus(c, { propertyId: prop, workOrderId: id });

  //  1  EXPLICIT AFFECTED PERSON WINS, even when a lease also names someone.
  //     Dana is ON THIS PROPERTY through her own lease (103); the work order
  //     is in 101, where Marcus holds the lease.
  const dana = await person("Dana Reyes");
  const marc = await person("Marcus Hale");
  const u3 = await unit("103"); await lease(u3, [dana]);
  const u1 = await unit("101"); await lease(u1, [marc]);
  const r1 = await read(await wo(u1, dana));
  ok("1  affected_person_id wins over the lease",
     r1.work_order.resident && r1.work_order.resident.person_id === dana
     && r1.work_order.resident.basis === "affected_person"
     && r1.work_order.resident_status === "resolved", JSON.stringify(r1.work_order.resident));

  //  2  A PERSON FROM ANOTHER PROPERTY IS NOT AN ANSWER. Property scope is
  //     enforced in the read, not assumed from the id being present.
  //     The outsider's only lease is on the OTHER property.
  const outsider = await person("Outsider");
  const uOther = await unit("901", other); await lease(uOther, [outsider], "active", other);
  const u2 = await unit("102");
  const r2 = await read(await wo(u2, outsider));
  ok("2  a cross-property affected person is REFUSED, not rendered",
     r2.work_order.resident === null && r2.work_order.resident_status === "none",
     JSON.stringify(r2.work_order.resident));

  //  3  UNAMBIGUOUS TENANCY resolves when no explicit person is set.
  const r3 = await read(await wo(u3, null));
  ok("3  a single leaseholder resolves, and says it came from tenancy",
     r3.work_order.resident && r3.work_order.resident.person_id === dana
     && r3.work_order.resident.basis === "tenancy", JSON.stringify(r3.work_order.resident));

  //  4  TWO LEASEHOLDERS: no basis to choose, so nobody is chosen.
  const u4 = await unit("104"); await lease(u4, [dana, marc]);
  const r4 = await read(await wo(u4, null));
  ok("4  two occupants produce AMBIGUOUS with a count, never an invented one",
     r4.work_order.resident === null && r4.work_order.resident_status === "ambiguous"
     && r4.work_order.resident_candidate_count === 2, JSON.stringify(r4.work_order));

  //  5  VACANT UNIT — a unit exists, nobody lives in it.
  const u5 = await unit("105");
  const r5 = await read(await wo(u5, null));
  ok("5  a vacant unit has no resident and is not ambiguous",
     r5.work_order.resident === null && r5.work_order.resident_status === "none"
     && r5.work_order.resident_candidate_count === 0, JSON.stringify(r5.work_order));

  //  6  COMMON AREA — no unit at all, so no tenancy question to ask.
  const r6 = await read(await wo(null, null));
  ok("6  common-area work has no unit, and no resident", r6.work_order.resident === null
     && r6.work_order.resident_status === "none", JSON.stringify(r6.work_order.resident));

  //  7  An inactive lease is not current tenancy.
  const u7 = await unit("107");
  await lease(u7, [dana], "ended");
  const r7 = await read(await wo(u7, null));
  ok("7  an ENDED lease is not current tenancy", r7.work_order.resident === null
     && r7.work_order.resident_status === "none", JSON.stringify(r7.work_order.resident));

  console.log(`\n  ${fail ? "✗ FAIL" : "✓ PASS"} — ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
