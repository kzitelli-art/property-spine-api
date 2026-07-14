#!/usr/bin/env node
/**
 * ESTABLISH ONE CANONICAL DEMO-BUILDING STAFF SESSION for the controlled
 * tenancy-anchor live proof. Ruling caution #1: this is NOT a login system —
 * it discovers an EXISTING assigned staff user and mints ONE expiring session
 * through the EXISTING controlled mint path (issueStaffSession), which the
 * SAME production resolveStaffSession reads back. Temporary issuance,
 * canonical session. No static operator key substitutes for identity.
 *
 * Run in the RENDER SHELL:  node establish_qa_staff_session.js
 *
 * It will:
 *   1. find staff users with an ACTIVE Demo Building assignment;
 *   2. confirm at least one holds the 'leasing' module (countersign authority);
 *   3. mint a 'bootstrap_invite' (12h, Class-2 proof) session for that user;
 *   4. print the raw session token to use as  x-staff-session  in the proof.
 *
 * It writes ONE canonical staff_sessions row and nothing else.
 */
const { Pool } = require("pg");
const svc = require("./staff_session_service");

const DB = process.env.DATABASE_URL;
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
if (!DB) { console.error("Set DATABASE_URL."); process.exit(2); }
const pool = new Pool({ connectionString: DB, ssl: DB.includes("neon") ? { rejectUnauthorized: false } : false });

(async () => {
  // 1) staff users with an ACTIVE assignment at Demo Building, plus their
  //    allowed_modules for that property (the action-authority fact).
  const rows = (await pool.query(
    `select u.id as user_id, u.name, u.role, a.role_title, a.allowed_modules, a.active
       from property_team_assignments a
       join users u on u.id = a.user_id
      where a.property_id = $1 and a.active = true
        and u.is_active = true and u.status = 'active'
      order by ('leasing' = any(a.allowed_modules)) desc, u.created_at`,
    [DEMO])).rows;

  if (rows.length === 0) {
    console.error("NO active Demo Building staff assignments found. A real staff user must be assigned to Demo Building (with the 'leasing' module) before the live proof can run. This is a data prerequisite, not a code gap.");
    await pool.end(); process.exit(1);
  }

  console.log("Active Demo Building staff:");
  for (const r of rows) {
    const hasLeasing = (r.allowed_modules || []).includes("leasing");
    console.log(`  ${r.name}  (user ${r.user_id})  role=${r.role}  title=${r.role_title}  modules=[${(r.allowed_modules||[]).join(",")}]  ${hasLeasing ? "✓ leasing" : "✗ no leasing"}`);
  }

  // 2) pick the first user WITH the leasing module (countersign authority).
  const authorized = rows.find(r => (r.allowed_modules || []).includes("leasing"));
  if (!authorized) {
    console.error("\nNo Demo Building staff user holds the 'leasing' module. Lease countersign/confirm-term require it. Grant a staff user the 'leasing' module on Demo Building (via the team-access flow) before proving. Data prerequisite.");
    await pool.end(); process.exit(1);
  }

  // 3) mint ONE canonical session through the EXISTING controlled path.
  const client = await pool.connect();
  let issued;
  try {
    issued = await svc.issueStaffSession(client, {
      userId: authorized.user_id,
      propertyId: DEMO,
      purpose: "bootstrap_invite",   // Class-2 interim proof credential, 12h TTL
    });
  } finally { client.release(); }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("CANONICAL DEMO-BUILDING STAFF SESSION ISSUED (Class-2, 12h)");
  console.log("  user:       " + authorized.name + " (" + authorized.user_id + ")");
  console.log("  property:   Demo Building");
  console.log("  expires_at: " + issued.expires_at);
  console.log("");
  console.log("  x-staff-session token (use in the proof, shown ONCE):");
  console.log("  " + issued.session_token);
  console.log("════════════════════════════════════════════════════════════");
  console.log("\nNext: put this token in the concurrency proof as the x-staff-session header,");
  console.log("with COMMITMENT_LEDGER_MODE=enabled and ACTIVATION_PROPERTY_IDS=" + DEMO);
  await pool.end();
})().catch(e => { console.error("session establishment error:", e.message || e); process.exit(3); });
