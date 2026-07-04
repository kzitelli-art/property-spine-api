// ════════════════════════════════════════════════════════════════════
//  seed_bridge_demo_staff.js — bridges the demo staff THROUGH THE SAME
//  AUDITED WORKFLOW as production (contract Part 4). No direct
//  users.person_id writes. No happy-path-only seeding: this script
//  deliberately leaves one host unbridged so the demo proves BOTH paths —
//  bridged host owns the follow-up; unbridged host's claim is preserved
//  and the task falls back honestly.
//
//  What it does, all against the "Property Spine Demo Building" only:
//    1. Finds the demo property + the demo admin (the leasing_manager the
//       demo bootstrap mints sessions for). Classifies it human_staff and
//       SELF-bridges it (the bootstrap rule: admin authority is the
//       account, not a pre-existing bridge).
//    2. Ensures demo staff users exist (Kandice, Katie, John Banks,
//       Jordan Avery), classifies them, bridges each to a safe staff
//       person (created WITH an active staff context — never a bare
//       default-'lead' row), and creates an active demo-property
//       assignment for the BRIDGED hosts.
//    3. Leaves ONE user (John Banks) classified but UNBRIDGED on purpose:
//       the honest-fallback proof subject.
//
//  Fail-closed: DEMO_MODE=true required; property resolved by the exact
//  constant name; refuses to run otherwise.
//
//  These are DEMO PERSONAS at the Demo Building (internal emails), not the
//  durable records of the real humans — real-staff onboarding at real
//  properties bridges separately, through the same workflow, later.
//
//  Run (Render shell — there is deliberately NO HTTP path for demo-session
//  bridge admin):  DEMO_MODE=true DATABASE_URL=... node seeds/seed_bridge_demo_staff.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const buildStaffBridge = require("../staffbridge.js");

const DEMO_PROPERTY_NAME = "Property Spine Demo Building"; // must match operator.js + leasingleads.js exactly

async function main() {
  if (process.env.DEMO_MODE !== "true") {
    console.error("Refusing: DEMO_MODE=true is required. This seed touches only the demo property.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const svc = buildStaffBridge({ pool })._service;

  const c = await pool.connect();
  try {
    await c.query("begin");

    const prop = (await c.query(
      `select id from properties where name = $1`, [DEMO_PROPERTY_NAME])).rows[0];
    if (!prop) throw new Error(`demo property "${DEMO_PROPERTY_NAME}" not found — aborting (no fallback, no guessing)`);

    // ── 1. the demo admin: classify + self-bridge (bootstrap rule) ──
    const admin = (await c.query(
      `select id, name from users where role = 'leasing_manager'::role_name
        and is_active = true and status = 'active' order by created_at asc limit 1`)).rows[0];
    if (!admin) throw new Error("no active leasing_manager found to act as the demo bridge admin");

    await svc.classifyAccount(c, { user_id: admin.id, account_kind: "human_staff",
                                   performed_by_user_id: admin.id });
    const adminBridged = (await c.query(`select person_id from users where id=$1`, [admin.id])).rows[0];
    if (!adminBridged.person_id) {
      await svc.linkBridge(c, {
        user_id: admin.id,
        create_staff_person: { name: admin.name, property_id: prop.id },
        reason_code: "demo_seed_bootstrap",
        reason_detail: "demo admin self-bridge — bootstrap authority is the authenticated admin account",
        evidence_type: "operator_attestation",
        performed_by_user_id: admin.id,
        request_id: "seed-bridge-admin-v1",
      });
    }

    // ── 2. the demo staff roster ──
    // bridged+assigned: Kandice (host who OWNS), Katie (leasing), Jordan Avery.
    // classified but UNBRIDGED on purpose: John Banks (fallback proof subject).
    const STAFF = [
      { name: "Kandice — Demo",     email: "kandice@propertyspine.internal",   role: "leasing_agent",    bridge: true,  assign_role: "leasing" },
      { name: "Katie — Demo",       email: "katie@propertyspine.internal",     role: "leasing_manager",  bridge: true,  assign_role: "leasing" },
      { name: "Jordan Avery — Demo", email: "jordan.avery@propertyspine.internal", role: "property_manager", bridge: true, assign_role: "property_manager" },
      { name: "John Banks — Demo",  email: "john.banks@propertyspine.internal", role: "maintenance",     bridge: false, assign_role: null },
    ];

    for (const s of STAFF) {
      let u = (await c.query(`select id, person_id from users where lower(email)=lower($1)`, [s.email])).rows[0];
      if (!u) {
        u = (await c.query(
          `insert into users (name, email, role) values ($1,$2,$3::role_name) returning id, person_id`,
          [s.name, s.email, s.role])).rows[0];
      }
      await svc.classifyAccount(c, { user_id: u.id, account_kind: "human_staff",
                                     performed_by_user_id: admin.id });
      if (s.bridge && !u.person_id) {
        const out = await svc.linkBridge(c, {
          user_id: u.id,
          create_staff_person: { name: s.name, email: s.email, property_id: prop.id },
          reason_code: "demo_seed",
          reason_detail: `demo staff bridge for ${s.name} — same audited workflow as production`,
          evidence_type: "operator_attestation",
          performed_by_user_id: admin.id,           // server-attributed admin, never body-supplied
          request_id: `seed-bridge-${s.name.toLowerCase().replace(/\s+/g, "-")}-v1`,
        });
        // active demo-property assignment → the person becomes ELIGIBLE here
        await c.query(
          `insert into assignments (person_id, property_id, role, scope, is_active, provenance)
           select $1, $2, $3, 'leasing', true, '{"source":"seed_bridge_demo_staff"}'::jsonb
            where not exists (select 1 from assignments where person_id=$1 and property_id=$2 and is_active=true)`,
          [out.person_id, prop.id, s.assign_role]);
        console.log(`  ✓ ${s.name}: classified, bridged (audited), assigned at demo property`);
      } else if (!s.bridge) {
        console.log(`  ✓ ${s.name}: classified human_staff, DELIBERATELY UNBRIDGED — the honest-fallback proof subject`);
      } else {
        console.log(`  • ${s.name}: already bridged — untouched (bridges are deliberate; re-links are explicit acts)`);
      }
    }

    await c.query("commit");
    console.log("\nSeed complete. Coverage report will show: linked_and_eligible for Kandice/Katie/Jordan, unbridged for John Banks.");
  } catch (e) {
    await c.query("rollback");
    console.error("SEED FAILED — rolled back, nothing applied:", e.message);
    process.exit(1);
  } finally {
    c.release();
    await pool.end();
  }
}
main();
