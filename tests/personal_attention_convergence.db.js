#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const obligations = require("../src/obligations/operator_obligations_service");

const HARNESS = __filename;
const EXPECTED = 13;
const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, max: 3 });
const tag = `PERSONAL_ATTN_${process.pid}_${Date.now()}`;

let passed = 0;
let failed = 0;
let ran = 0;
function ok(label, condition, detail = "") {
  ran += 1;
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  ->  " + detail : "")); }
}

(async () => {
  receipt.begin(HARNESS, { url: URL, expected: EXPECTED });
  let organizationId = null;
  let propertyId = null;
  const personIds = [];
  const userIds = [];
  const obligationIds = [];

  try {
    organizationId = (await pool.query(
      `insert into organizations (name, slug) values ($1, $2) returning id`,
      [`${tag} Org`, tag.toLowerCase().replace(/_/g, "-")]
    )).rows[0].id;
    propertyId = (await pool.query(
      `insert into properties (name, canonical_key, organization_id)
       values ($1, $2, $3) returning id`,
      [`${tag} Property`, `${tag}-PROPERTY`, organizationId]
    )).rows[0].id;

    for (const label of ["Me", "Other"]) {
      const personId = (await pool.query(
        `insert into persons (name) values ($1) returning id`, [`${tag} ${label}`]
      )).rows[0].id;
      personIds.push(personId);
      const userId = (await pool.query(
        `insert into users
           (name, email, role, platform_role, organization_id, is_active, status, person_id)
         values ($1, $2, 'leasing_agent', 'member', $3, true, 'active', $4)
         returning id`,
        [`${tag} ${label}`, `${tag.toLowerCase()}-${label.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}@example.test`,
          organizationId, personId]
      )).rows[0].id;
      userIds.push(userId);
    }
    const [me, other] = userIds;

    const insertObligation = async (label, module, status, assignedUser, escalatesTo, dueSql, assignedRole = null) => {
      const row = (await pool.query(
        `insert into obligations
           (property_id, module, type, label, status, assigned_user_id,
            escalates_to_user_id, assigned_role, due_at)
         values ($1, $2, 'harness', $3, $4, $5, $6, $7, ${dueSql})
         returning id`,
        [propertyId, module, `${tag} ${label}`, status, assignedUser, escalatesTo, assignedRole]
      )).rows[0];
      obligationIds.push(row.id);
      return row.id;
    };

    const primary = await insertObligation("Unassigned leasing", "leasing", "open", null, null,
      "now() - interval '2 days'");
    const direct = await insertObligation("Direct assignment", "leasing", "open", me, null,
      "now() - interval '1 day'");
    const escalated = await insertObligation("Escalated explicitly", "management", "open", other, me,
      "now() + interval '1 day'");
    const someoneElse = await insertObligation("Someone else's work", "leasing", "open", other, null,
      "now() + interval '2 days'");
    const roleOnly = await insertObligation("Role title only", "management", "open", null, null,
      "now() + interval '3 days'", "leasing_agent");
    const outsideAccess = await insertObligation("Outside module access", "maintenance", "open", me, null,
      "now() + interval '4 days'");
    const complete = await insertObligation("Already complete", "leasing", "complete", me, null,
      "now() - interval '3 days'");

    const out = await obligations.personalAttention(pool, {
      property_id: propertyId,
      allowed_modules: ["leasing", "management"],
      operator_user_id: me,
      primary_for_modules: ["leasing", "maintenance"],
    });
    const ids = out.items.map((item) => item.id);

    ok("three recorded personal items qualify", out.total === 3, String(out.total));
    ok("the personal result contains exactly those three", out.items.length === 3);
    ok("unassigned work in a primary module ranks first", ids[0] === primary, JSON.stringify(ids));
    ok("direct assignment ranks after the more urgent unassigned item", ids[1] === direct);
    ok("explicit escalation remains in the personal queue", ids[2] === escalated);
    ok("the primary-module basis is explicit", out.items[0].personal_basis === "unassigned_in_your_module");
    ok("the direct basis is explicit", out.items[1].personal_basis === "assigned_to_you");
    ok("the escalation basis is explicit", out.items[2].personal_basis === "escalated_to_you");
    ok("another person's assigned work is excluded", !ids.includes(someoneElse));
    ok("a matching role title alone grants no personal work", !ids.includes(roleOnly));
    ok("direct work outside module entitlement is excluded", !ids.includes(outsideAccess));
    ok("completed work is excluded", !ids.includes(complete));

    const propertyWide = await obligations.attention(pool, {
      property_id: propertyId, allowed_modules: ["leasing", "management"],
    });
    ok("the existing property attention read remains broader", propertyWide.total === 5,
      String(propertyWide.total));
  } finally {
    if (obligationIds.length) {
      await pool.query(`delete from obligations where id = any($1::uuid[])`, [obligationIds]).catch(() => {});
    }
    for (const userId of userIds) await pool.query(`delete from users where id = $1`, [userId]).catch(() => {});
    for (const personId of personIds) await pool.query(`delete from persons where id = $1`, [personId]).catch(() => {});
    if (propertyId) await pool.query(`delete from properties where id = $1`, [propertyId]).catch(() => {});
    if (organizationId) await pool.query(`delete from organizations where id = $1`, [organizationId]).catch(() => {});
    await pool.end();
  }

  process.exitCode = receipt.complete({
    harness: HARNESS, passed, failed: failed + Math.max(0, EXPECTED - ran), expectedAtLeast: EXPECTED,
  });
})().catch(async (error) => {
  await pool.end().catch(() => {});
  process.exitCode = receipt.died(HARNESS, error, ran);
});
