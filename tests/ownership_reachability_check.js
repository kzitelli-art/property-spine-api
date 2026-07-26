#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  ownership_reachability_check.js — is assigned work ACTIONABLE?
//
//  THE DEFECT THIS SURFACES
//  ------------------------
//  Property Spine answers "does this person work at this property?" from
//  TWO different tables, and the two are not reconciled:
//
//    assignments                (person_id-keyed)
//      → staff_identity_resolver.resolveEligibleOwner
//      → decides who work is ASSIGNED to
//
//    property_team_assignments  (user_id-keyed)
//      → leasingconversion.resolveSendActionBasis
//      → identity/activation_perimeter
//      → decides who may ACT on it
//
//  Nothing keeps them in agreement. When they diverge, the product
//  cheerfully assigns a commitment to someone who then cannot complete
//  it — and neither can anyone else, because coverage is also read from
//  the second table. The obligation is not broken, not overdue, not
//  flagged: it is simply unreachable, and it looks perfectly healthy.
//
//  Measured at Demo Building on 2026-07-26 the two sets were entirely
//  DISJOINT: 3 people assignable, 4 authorised, zero overlap. Every
//  auto-assigned obligation there was landing on someone who could not
//  action it.
//
//  This check does not fix anything and must not. Reconciling the two —
//  granting team assignments, or narrowing who may be assigned — decides
//  who holds authority over real work, which is an owner's call, not a
//  harness's.
//
//  CLASS 3 — read-only diagnostic. Writes nothing.
//  EXIT 1 when open work is parked on someone who cannot act on it.
//
//  RUN:  DATABASE_URL=... node tests/ownership_reachability_check.js [property_id]
// ════════════════════════════════════════════════════════════════════
"use strict";

const { Pool } = require("pg");
const PROPERTY = process.argv[2] || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

(async () => {
  if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL."); process.exit(2); }
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const prop = (await p.query(`select name from properties where id=$1`, [PROPERTY])).rows[0];
  const bar = "─".repeat(66);
  console.log(`\n${bar}\nOWNERSHIP REACHABILITY — ${prop ? prop.name : PROPERTY}\n${bar}`);

  // who the assignment resolver will hand work to
  const assignable = (await p.query(
    `select distinct u.id, u.name, u.role
       from users u
       join assignments a on a.person_id = u.person_id
      where a.property_id = $1 and a.is_active = true
        and u.is_active = true and u.status = 'active'
        and u.account_kind = 'human_staff' and u.person_id is not null
      order by u.name`, [PROPERTY])).rows;

  // who the action gates will let act
  const authorised = (await p.query(
    `select distinct u.id, u.name, u.role, t.allowed_modules
       from users u
       join property_team_assignments t on t.user_id = u.id
      where t.property_id = $1 and t.active = true
        and u.is_active = true and u.status = 'active'
      order by u.name`, [PROPERTY])).rows;

  const authIds = new Set(authorised.map((r) => String(r.id)));
  const assignIds = new Set(assignable.map((r) => String(r.id)));
  const both = assignable.filter((r) => authIds.has(String(r.id)));

  console.log(`\n  assignable (assignments):                 ${assignable.length}`);
  for (const r of assignable) {
    console.log(`     ${authIds.has(String(r.id)) ? "✓" : "✗"} ${String(r.name).padEnd(28)} ${r.role}`);
  }
  console.log(`\n  authorised (property_team_assignments):   ${authorised.length}`);
  for (const r of authorised) {
    console.log(`     ${assignIds.has(String(r.id)) ? "✓" : "·"} ${String(r.name).padEnd(28)} ${r.role}`);
  }
  console.log(`\n  BOTH — can be given work AND can do it:   ${both.length}`);
  for (const r of both) console.log(`       ${r.name}`);
  if (both.length === 0) {
    console.log(`       (none — the two sets are entirely disjoint)`);
  }

  // the consequence, in live work
  const parked = (await p.query(
    `select o.id, o.type, o.label, o.created_at, u.name owner
       from obligations o
       left join users u on u.id = o.assigned_user_id
      where o.property_id = $1 and o.status = 'open'
        and o.assigned_user_id is not null
        and not exists (
          select 1 from property_team_assignments t
           where t.user_id = o.assigned_user_id
             and t.property_id = o.property_id and t.active = true)
      order by o.created_at`, [PROPERTY])).rows;

  console.log(`\n${bar}`);
  console.log(`OPEN work parked on someone who cannot act on it: ${parked.length}`);
  for (const o of parked) {
    console.log(`  ${String(o.created_at).slice(4, 16)}  ${String(o.type).padEnd(30)} owner=${o.owner}`);
    console.log(`      ${o.id}`);
  }

  if (parked.length === 0 && both.length > 0) {
    console.log(`\nNothing unreachable right now. Note this can go wrong again at any`);
    console.log(`time — nothing enforces agreement between the two tables.`);
  } else if (parked.length === 0) {
    console.log(`\nNo work is parked YET, but no one is both assignable and authorised,`);
    console.log(`so the next auto-assigned obligation here will be unreachable.`);
  } else {
    console.log(`\nThese are not overdue, not failed, not flagged anywhere. They look`);
    console.log(`healthy. Nobody — including the named owner — can complete them.`);
  }
  console.log(`${bar}\n`);
  await p.end();
  process.exitCode = parked.length > 0 || both.length === 0 ? 1 : 0;
})().catch((e) => { console.error("check error:", e.message); process.exit(1); });
